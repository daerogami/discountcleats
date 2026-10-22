import { CurrencyPipe, DecimalPipe } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Listing, buildDeals, listingFromDeal } from '../dsg/compare';
import { CatalogSnapshot, DsgCatalog } from '../dsg/catalog';
import {
  BoardFilters,
  DEFAULT_FILTERS,
  FACET,
  GENDER_ORDER,
  RETAILERS,
  SITE_NAME,
  SIZE_FACET,
  SURFACE_ORDER,
  RetailerId,
  SizeGroup,
  SortKey,
  isSortKey,
  retailerLabel,
  sizeLabel,
  sizeRank,
} from '../dsg/model';
import { ShopifyCatalog } from '../dsg/shopify';
import { SOCCER_LISTING_CAP, SoccerCatalog } from '../dsg/soccer';
import {
  STORAGE_KEY,
  canonicalMap,
  canonicalQuery,
  facetChoices,
  filtersFromParams,
  readStoredFilters,
  sameFilters,
  sanitize,
  selectDeals,
  serializeFilters,
  serverKey,
} from '../dsg/query';

@Component({
  selector: 'app-deals',
  imports: [CurrencyPipe, DecimalPipe],
  templateUrl: './deals.html',
  styleUrl: './deals.css',
})
export class Deals {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly catalog = inject(DsgCatalog);
  private readonly injector = inject(Injector);
  private readonly shopify = inject(ShopifyCatalog);
  private readonly soccer = inject(SoccerCatalog);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly siteName = SITE_NAME;
  protected readonly sizeLabel = sizeLabel;
  protected readonly filters = signal<BoardFilters>(this.initialFilters());
  protected readonly skeletons = [0, 1, 2, 3, 4, 5];
  protected readonly sizeGroups: { id: SizeGroup; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'mens', label: "Men's" },
    { id: 'womens', label: "Women's" },
    { id: 'kids', label: 'Kids' },
  ];
  protected readonly retailers = RETAILERS;
  protected readonly retailerLabel = retailerLabel;
  protected readonly soccerListingCap = SOCCER_LISTING_CAP;
  private readonly sorts: { id: SortKey; label: string }[] = [
    { id: 'price-asc', label: 'Lowest price' },
    { id: 'discount-desc', label: 'Percent off' },
    { id: 'savings-desc', label: 'Dollars saved' },
    { id: 'price-desc', label: 'Highest price' },
    { id: 'rating-desc', label: 'Top rated' },
  ];

  private readonly listings = signal<Record<RetailerId, Listing[]>>({
    dicks: [],
    soccer: [],
    prosoccer: [],
    unisport: [],
  });
  private readonly sourceStatus = signal<Record<RetailerId, SourceStatus>>({
    dicks: 'idle',
    soccer: 'idle',
    prosoccer: 'idle',
    unisport: 'idle',
  });
  private readonly sourceError = signal<Record<RetailerId, string | null>>({
    dicks: null,
    soccer: null,
    prosoccer: null,
    unisport: null,
  });
  private readonly committedFilters = signal<BoardFilters>(this.filters());
  protected readonly holdingPrevious = signal(false);
  private readonly windowEl = viewChild<ElementRef<HTMLElement>>('window');
  private readonly cardAnchors = viewChildren<ElementRef<HTMLAnchorElement>>('dealCard');
  private readonly windowLayout = signal<WindowLayout>({
    columns: guessColumns(window.innerWidth),
    rowHeight: 0,
    gap: 12,
  });
  private readonly windowBounds = signal<WindowBounds>({ startRow: 0, endRow: 0, measured: false });
  private readonly pendingFocus = signal<number | null>(null);
  private readonly resizeObserver = new ResizeObserver(() => this.syncWindow());
  private filterSignature = '';
  private sawFilters = false;
  protected readonly columnCount = computed(() => this.windowLayout().columns);
  protected readonly rowHeight = computed(() => this.windowLayout().rowHeight);
  protected readonly windowed = computed(() => {
    const deals = this.visible();
    const columns = Math.max(1, this.columnCount());
    const { startRow, endRow, measured } = this.windowBounds();
    if (!measured) return deals.slice(0, columns * FIRST_ROWS);
    return deals.slice(startRow * columns, Math.min(deals.length, endRow * columns));
  });
  protected readonly padTop = computed(() => this.rowSpan(this.windowBounds().startRow));
  protected readonly padBottom = computed(() => {
    const { startRow, endRow, measured } = this.windowBounds();
    if (!measured) return 0;
    const hidden = Math.max(0, this.totalRows() - endRow);
    const span = this.rowSpan(hidden);
    if (span === 0 || endRow > startRow) return span;
    return Math.max(0, span - this.windowLayout().gap);
  });
  protected readonly facets = signal<CatalogSnapshot['facets']>({});
  protected readonly total = signal(0);
  protected readonly scanned = signal(0);
  protected readonly capped = signal(false);
  protected readonly soccerCapped = signal(false);
  protected readonly status = computed<'loading' | 'ready' | 'error'>(() => {
    const states = this.filters().retailers.map((id) => this.sourceStatus()[id]);
    if (states.some((state) => state === 'loading' || state === 'idle')) return 'loading';
    if (states.every((state) => state === 'error')) return 'error';
    return 'ready';
  });
  protected readonly error = computed(() => {
    const messages = this.filters()
      .retailers.map((id) => this.sourceError()[id])
      .filter((message): message is string => !!message);
    return messages.length ? messages.join(' ') : null;
  });

  protected readonly shownFilters = computed(() => {
    const live = this.filters();
    if (!this.holdingPrevious()) return live;
    const committed = this.committedFilters();
    return {
      ...committed,
      minDiscount: live.minDiscount,
      maxPrice: live.maxPrice,
      sort: live.sort,
      query: live.query,
      retailers: live.retailers,
    };
  });
  protected readonly activeSort = computed(() => {
    const filters = this.shownFilters();
    if (filters.retailers.length > 1 && filters.sort === 'rating-desc')
      return 'price-asc' as SortKey;
    return filters.sort;
  });
  protected readonly sortChoices = computed(() =>
    this.shownFilters().retailers.length > 1
      ? this.sorts.filter((option) => option.id !== 'rating-desc')
      : this.sorts,
  );
  protected readonly summaryKnown = computed(() =>
    this.filters().retailers.some((id) => this.sourceStatus()[id] === 'ready'),
  );
  protected readonly progressText = computed(() => {
    const loading = this.filters().retailers.filter((id) => {
      const state = this.sourceStatus()[id];
      return state === 'loading' || state === 'idle';
    });
    if (loading.length === 1 && loading[0] === 'dicks' && this.total() > 0) {
      return `Read ${this.scanned()} of ${this.total()}`;
    }
    if (!loading.length) return 'Checking the shops';
    return `Checking ${joinLabels(loading.map((id) => retailerLabel(id)))}`;
  });
  protected readonly visible = computed(() => {
    const filters = this.shownFilters();
    const listings = filters.retailers.flatMap((id) => this.listings()[id]);
    return selectDeals(buildDeals(listings, filters), { ...filters, sort: this.activeSort() });
  });
  protected readonly summary = computed(() => {
    const deals = this.visible();
    let deepest = 0;
    let savings = 0;
    for (const deal of deals) {
      deepest = Math.max(deepest, deal.discount);
      savings += deal.savings;
    }
    return { count: deals.length, deepest: Math.round(deepest), savings };
  });
  protected readonly heading = computed(() => {
    const count = this.summary().count;
    if (!this.summaryKnown()) return 'Deals';
    const filters = this.shownFilters();
    const types = filters.productTypes;
    const noun = types.length === 1 && types[0] === 'Cleats' ? 'cleats' : 'items';
    const who =
      filters.genders.length > 0 || filters.sizeGroup === 'all'
        ? ''
        : filters.sizeGroup === 'mens'
          ? "men's "
          : filters.sizeGroup === 'womens'
            ? "women's "
            : 'kids ';
    return `${count} ${who}${noun}`;
  });
  protected readonly isDefault = computed(() =>
    sameFilters(this.filters(), sanitize(DEFAULT_FILTERS)),
  );
  protected readonly productTypeChoices = computed(() =>
    facetChoices(this.facets()[FACET.productType] ?? [], this.filters().productTypes, ['Cleats']),
  );
  protected readonly surfaceChoices = computed(() => {
    const extra = this.filters().retailers.some((id) => id !== 'dicks')
      ? SURFACE_ORDER.map((value) => ({ value, count: 0 }))
      : [];
    return facetChoices(
      [...extra, ...(this.facets()[FACET.surface] ?? [])],
      this.filters().surfaces,
      SURFACE_ORDER,
    );
  });
  protected readonly genderChoices = computed(() => {
    const extra = this.filters().retailers.some((id) => id !== 'dicks')
      ? GENDER_ORDER.map((value) => ({ value, count: 0 }))
      : [];
    return facetChoices(
      [...extra, ...(this.facets()[FACET.gender] ?? [])],
      this.filters().genders,
      GENDER_ORDER,
    );
  });
  protected readonly brandChoices = computed(() =>
    facetChoices(this.facets()[FACET.brand] ?? [], this.filters().brands),
  );
  protected readonly sizeOptions = computed(() => {
    const group = this.filters().sizeGroup;
    if (group === 'all') return [];
    const selected = this.filters().size;
    const values = facetChoices(this.facets()[SIZE_FACET[group]] ?? [], selected ? [selected] : []);
    return values.sort(
      (a, b) => sizeRank(a.value) - sizeRank(b.value) || a.value.localeCompare(b.value),
    );
  });
  protected readonly meter = computed(() => {
    const total = this.total();
    if (total <= 0) return '0%';
    return `${Math.min(100, (this.scanned() / total) * 100)}%`;
  });

  private readonly ticket: Record<RetailerId, number> = {
    dicks: 0,
    soccer: 0,
    prosoccer: 0,
    unisport: 0,
  };
  private readonly controllers: Partial<Record<RetailerId, AbortController>> = {};
  private readonly shopifyStarted = new Set<'prosoccer' | 'unisport'>();
  private soccerStarted = false;
  private dicksKey = '';
  private skipEmptyUrl = this.route.snapshot.queryParamMap.keys.length === 0;
  private pendingUrl = '';

  constructor() {
    effect(() => {
      const filters = this.filters();
      untracked(() => {
        this.remember(filters);
        this.syncUrl(filters);
        this.syncSources(filters);
      });
    });

    this.destroyRef.onDestroy(() => {
      for (const controller of Object.values(this.controllers)) controller?.abort();
      window.removeEventListener('scroll', this.syncWindow);
      window.removeEventListener('resize', this.syncWindow);
      this.resizeObserver.disconnect();
    });

    afterNextRender(() => {
      window.addEventListener('scroll', this.syncWindow, { passive: true });
      window.addEventListener('resize', this.syncWindow);
      const el = this.windowEl()?.nativeElement;
      if (el) this.resizeObserver.observe(el);
      this.syncWindow();
    });

    effect(() => {
      const el = this.windowEl()?.nativeElement;
      untracked(() => {
        this.resizeObserver.disconnect();
        if (el) this.resizeObserver.observe(el);
        this.syncWindow();
      });
    });

    effect(() => {
      const signature = JSON.stringify(this.shownFilters());
      untracked(() => {
        if (!this.sawFilters) {
          this.sawFilters = true;
          this.filterSignature = signature;
          return;
        }
        if (signature === this.filterSignature) return;
        this.filterSignature = signature;
        this.windowBounds.set({ startRow: 0, endRow: 0, measured: false });
        this.pinBoard();
        this.syncWindow();
      });
    });

    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((map) => {
      const current = canonicalMap(map);
      if (this.pendingUrl) {
        if (current === this.pendingUrl) this.pendingUrl = '';
        return;
      }
      if (map.keys.length === 0 && this.skipEmptyUrl) {
        this.skipEmptyUrl = false;
        return;
      }
      this.skipEmptyUrl = false;
      const next = map.keys.length ? filtersFromParams(map) : sanitize(DEFAULT_FILTERS);
      if (sameFilters(next, this.filters())) return;
      this.filters.set(next);
    });
  }

  protected patch(partial: Partial<BoardFilters>): void {
    this.filters.update((current) => sanitize({ ...current, ...partial }));
  }

  protected toggle(key: 'brands' | 'surfaces' | 'genders' | 'productTypes', value: string): void {
    this.filters.update((current) => {
      const list = current[key];
      const next = list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
      return sanitize({ ...current, [key]: next });
    });
  }

  protected setSizeGroup(group: SizeGroup): void {
    if (this.filters().sizeGroup === group) return;
    this.patch({ sizeGroup: group, size: null, genders: [] });
  }

  protected toggleRetailer(id: RetailerId): void {
    const current = this.filters().retailers;
    const retailers = current.includes(id)
      ? current.filter((item) => item !== id)
      : [...current, id];
    if (!retailers.length) return;
    const ordered = RETAILERS.map((retailer) => retailer.id).filter((item) =>
      retailers.includes(item),
    );
    this.patch({ retailers: ordered });
  }

  protected reset(): void {
    this.filters.set(sanitize(DEFAULT_FILTERS));
  }

  protected retry(): void {
    const filters = this.filters();
    const failed = new Set(filters.retailers.filter((id) => this.sourceStatus()[id] === 'error'));
    if (failed.has('dicks')) {
      this.catalog.forget(serverKey(filters));
      this.dicksKey = '';
    }
    for (const id of ['prosoccer', 'unisport'] as const) {
      if (!failed.has(id)) continue;
      this.shopify.forget(id);
      this.shopifyStarted.delete(id);
    }
    if (failed.has('soccer')) {
      this.soccer.forget();
      this.soccerStarted = false;
    }
    this.syncSources(filters);
  }

  protected onQuery(event: Event): void {
    this.patch({ query: (event.target as HTMLInputElement).value });
  }

  protected onSort(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (!isSortKey(value)) return;
    this.patch({ sort: value });
  }

  protected onDiscount(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) this.patch({ minDiscount: value });
  }

  protected onMaxPrice(event: Event): void {
    const raw = (event.target as HTMLInputElement).value.trim();
    this.patch({ maxPrice: raw ? Number(raw) : null });
  }

  protected onSize(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.patch({ size: value || null });
  }

  protected onZip(event: Event): void {
    const input = event.target as HTMLInputElement;
    const zip = input.value.trim();
    if (/^\d{5}$/.test(zip)) {
      this.patch({ zip });
      return;
    }
    input.value = this.filters().zip;
  }

  protected onStoreNumber(event: Event): void {
    const input = event.target as HTMLInputElement;
    const storeNumber = input.value.trim();
    if (/^\d{1,12}$/.test(storeNumber)) {
      this.patch({ storeNumber });
      return;
    }
    input.value = this.filters().storeNumber;
  }

  protected onStoreId(event: Event): void {
    const input = event.target as HTMLInputElement;
    const storeId = Number(input.value);
    if (Number.isInteger(storeId) && storeId > 0) {
      this.patch({ storeId });
      return;
    }
    input.value = String(this.filters().storeId);
  }

  protected absoluteIndex(localIndex: number): number {
    const columns = Math.max(1, this.windowLayout().columns);
    return this.windowBounds().startRow * columns + localIndex;
  }

  protected onCardKey(event: KeyboardEvent, localIndex: number): void {
    if (event.key !== 'Tab' || event.altKey || event.ctrlKey || event.metaKey) return;
    const forward = !event.shiftKey;
    const mounted = this.windowed().length;
    if (forward ? localIndex < mounted - 1 : localIndex > 0) return;
    const columns = Math.max(1, this.windowLayout().columns);
    const absolute = this.windowBounds().startRow * columns + localIndex + (forward ? 1 : -1);
    if (absolute < 0 || absolute >= this.visible().length) return;
    event.preventDefault();
    this.pendingFocus.set(absolute);
    this.revealCard(absolute, forward);
    afterNextRender(
      () => {
        const index = this.pendingFocus();
        if (index === null) return;
        const start = this.windowBounds().startRow * Math.max(1, this.windowLayout().columns);
        const anchor = this.cardAnchors()[index - start]?.nativeElement;
        if (!anchor) return;
        anchor.focus({ preventScroll: true });
        this.pendingFocus.set(null);
      },
      { injector: this.injector },
    );
  }

  protected useFallback(event: Event, deal: CatalogSnapshot['deals'][number]): void {
    const img = event.target;
    if (!(img instanceof HTMLImageElement)) return;
    if (img.dataset['fallback'] === '1' || deal.fallbackImageUrl === deal.imageUrl) {
      img.hidden = true;
      return;
    }
    img.dataset['fallback'] = '1';
    img.src = deal.fallbackImageUrl;
  }

  private syncWindow = (): void => {
    const host = this.windowEl()?.nativeElement;
    if (!host) return;
    const style = getComputedStyle(host);
    const tracks = style.gridTemplateColumns
      .split(' ')
      .map((part) => Number.parseFloat(part))
      .filter((width) => width > 0);
    const columns = Math.max(1, tracks.length);
    const gap = Number.parseFloat(style.rowGap) || 12;
    let rowHeight = this.windowLayout().rowHeight;
    const card = host.querySelector('.card');
    if (card instanceof HTMLElement) {
      const photo = card.querySelector('.photo');
      const body = card.querySelector('.body');
      if (photo instanceof HTMLElement && body instanceof HTMLElement) {
        const border = card.offsetHeight - card.clientHeight;
        const measured =
          photo.getBoundingClientRect().height + body.getBoundingClientRect().height + border;
        if (rowHeight <= 0 || Math.abs(measured - rowHeight) > 1) rowHeight = measured;
      }
    }
    if (rowHeight <= 0) return;
    const layout = this.windowLayout();
    if (layout.columns !== columns || layout.gap !== gap || layout.rowHeight !== rowHeight) {
      this.windowLayout.set({ columns, gap, rowHeight });
    }
    const rect = host.getBoundingClientRect();
    const next = rowRange({
      top: rect.top,
      viewport: window.innerHeight,
      totalRows: Math.ceil(this.visible().length / columns),
      stride: rowHeight + gap,
      overscan: OVERSCAN_ROWS,
    });
    const current = this.windowBounds();
    if (current.measured && current.startRow === next.startRow && current.endRow === next.endRow) {
      return;
    }
    this.windowBounds.set({ ...next, measured: true });
  };

  private revealCard(index: number, forward: boolean): void {
    const host = this.windowEl()?.nativeElement;
    const { rowHeight, gap, columns } = this.windowLayout();
    if (!host || rowHeight <= 0) return;
    const stride = rowHeight + gap;
    const rowTop =
      window.scrollY +
      host.getBoundingClientRect().top +
      Math.floor(index / Math.max(1, columns)) * stride;
    const top = forward ? rowTop + rowHeight - window.innerHeight + 16 : rowTop - 16;
    window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
    this.syncWindow();
  }

  private pinBoard(): void {
    const board = document.getElementById('board');
    if (!board || board.getBoundingClientRect().top >= 0) return;
    board.scrollIntoView({ block: 'start', behavior: 'auto' });
  }

  private rowSpan(rows: number): number {
    const { rowHeight, gap } = this.windowLayout();
    if (!rowHeight || rows <= 0) return 0;
    return rows * (rowHeight + gap);
  }

  private totalRows(): number {
    return Math.ceil(this.visible().length / Math.max(1, this.windowLayout().columns));
  }

  private initialFilters(): BoardFilters {
    const map = this.route.snapshot.queryParamMap;
    if (map.keys.length > 0) return filtersFromParams(map);
    return readStoredFilters() ?? sanitize(DEFAULT_FILTERS);
  }

  private remember(filters: BoardFilters): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(filters));
    } catch {
      // Private browsing can reject storage. The board still works for this visit.
    }
  }

  private syncUrl(filters: BoardFilters): void {
    const params = serializeFilters(filters);
    const next = canonicalQuery(params);
    if (next === canonicalMap(this.route.snapshot.queryParamMap)) return;
    this.pendingUrl = next;
    void this.router.navigate([], { queryParams: params, replaceUrl: true }).finally(() => {
      if (this.pendingUrl !== next) return;
      if (canonicalMap(this.route.snapshot.queryParamMap) === next) this.pendingUrl = '';
    });
  }

  private syncSources(filters: BoardFilters): void {
    const wanted = new Set(filters.retailers);
    if (!wanted.has('dicks')) {
      this.controllers.dicks?.abort();
      this.dicksKey = '';
      this.listings.update((current) => ({ ...current, dicks: [] }));
      this.sourceStatus.update((current) => ({ ...current, dicks: 'idle' }));
      this.holdingPrevious.set(false);
    } else {
      const key = serverKey(filters);
      if (key !== this.dicksKey) {
        this.dicksKey = key;
        void this.loadDicks(filters, key);
      }
    }

    for (const id of ['prosoccer', 'unisport'] as const) {
      if (!wanted.has(id) || this.shopifyStarted.has(id)) continue;
      this.shopifyStarted.add(id);
      void this.loadShopify(id);
    }

    if (!wanted.has('soccer')) {
      this.soccerCapped.set(false);
    } else if (!this.soccerStarted) {
      this.soccerStarted = true;
      void this.loadSoccer();
    }
  }

  private async loadDicks(filters: BoardFilters, key: string): Promise<void> {
    const ticket = ++this.ticket.dicks;
    this.controllers.dicks?.abort();
    const hold = this.listings().dicks.length > 0 && this.sourceStatus().dicks === 'ready';
    this.holdingPrevious.set(hold);
    this.sourceStatus.update((current) => ({ ...current, dicks: 'loading' }));
    this.sourceError.update((current) => ({ ...current, dicks: null }));
    if (!hold) {
      this.total.set(0);
      this.scanned.set(0);
    }

    const cached = await this.catalog.recall(key);
    if (ticket !== this.ticket.dicks) return;
    if (cached) {
      this.commitDicks(cached, ticket);
      return;
    }

    const controller = new AbortController();
    this.controllers.dicks = controller;
    try {
      await this.catalog.load(
        filters,
        key,
        (snapshot) => {
          if (ticket !== this.ticket.dicks) return;
          if (!hold || snapshot.done) this.commitDicks(snapshot, ticket);
          else {
            this.total.set(snapshot.total);
            this.scanned.set(snapshot.scanned);
          }
        },
        controller.signal,
      );
      if (ticket !== this.ticket.dicks) return;
      this.holdingPrevious.set(false);
      this.sourceStatus.update((current) => ({ ...current, dicks: 'ready' }));
    } catch (error) {
      if (ticket !== this.ticket.dicks || controller.signal.aborted) return;
      this.holdingPrevious.set(false);
      this.sourceError.update((current) => ({ ...current, dicks: messageFrom(error) }));
      if (hold) {
        this.listings.update((current) => ({ ...current, dicks: [] }));
        this.committedFilters.set(filters);
      }
      this.sourceStatus.update((current) => ({ ...current, dicks: 'error' }));
    }
  }

  private commitDicks(snapshot: CatalogSnapshot, ticket: number): void {
    if (ticket !== this.ticket.dicks) return;
    this.listings.update((current) => ({
      ...current,
      dicks: snapshot.deals.map((deal) => listingFromDeal(deal)),
    }));
    this.facets.set(snapshot.facets);
    this.total.set(snapshot.total);
    this.scanned.set(snapshot.scanned);
    this.capped.set(snapshot.capped);
    this.committedFilters.set(this.filters());
    this.holdingPrevious.set(false);
    if (snapshot.done) this.sourceStatus.update((current) => ({ ...current, dicks: 'ready' }));
  }

  private async loadSoccer(): Promise<void> {
    const ticket = ++this.ticket.soccer;
    this.controllers.soccer?.abort();
    this.sourceStatus.update((current) => ({ ...current, soccer: 'loading' }));
    this.sourceError.update((current) => ({ ...current, soccer: null }));
    const controller = new AbortController();
    this.controllers.soccer = controller;
    try {
      const result =
        this.soccer.cached() ??
        (await this.soccer.recall()) ??
        (await this.soccer.load(controller.signal));
      if (ticket !== this.ticket.soccer) return;
      this.listings.update((current) => ({ ...current, soccer: result.listings }));
      this.soccerCapped.set(result.capped);
      this.sourceStatus.update((current) => ({ ...current, soccer: 'ready' }));
    } catch (error) {
      if (ticket !== this.ticket.soccer || controller.signal.aborted) return;
      this.soccerStarted = false;
      this.soccerCapped.set(false);
      this.sourceError.update((current) => ({ ...current, soccer: messageFrom(error) }));
      this.sourceStatus.update((current) => ({ ...current, soccer: 'error' }));
    }
  }

  private async loadShopify(id: 'prosoccer' | 'unisport'): Promise<void> {
    const ticket = ++this.ticket[id];
    this.controllers[id]?.abort();
    this.sourceStatus.update((current) => ({ ...current, [id]: 'loading' }));
    this.sourceError.update((current) => ({ ...current, [id]: null }));
    const controller = new AbortController();
    this.controllers[id] = controller;
    try {
      const listings =
        this.shopify.cached(id) ??
        (await this.shopify.recall(id)) ??
        (await this.shopify.load(id, controller.signal));
      if (ticket !== this.ticket[id]) return;
      this.listings.update((current) => ({ ...current, [id]: listings }));
      this.sourceStatus.update((current) => ({ ...current, [id]: 'ready' }));
    } catch (error) {
      if (ticket !== this.ticket[id] || controller.signal.aborted) return;
      this.shopifyStarted.delete(id);
      this.sourceError.update((current) => ({ ...current, [id]: messageFrom(error) }));
      this.sourceStatus.update((current) => ({ ...current, [id]: 'error' }));
    }
  }
}

const OVERSCAN_ROWS = 2;
const FIRST_ROWS = 6;
const CARD_MIN = 220;
const GRID_GAP = 12;

interface WindowLayout {
  columns: number;
  rowHeight: number;
  gap: number;
}

interface WindowBounds {
  startRow: number;
  endRow: number;
  measured: boolean;
}

function guessColumns(viewportWidth: number): number {
  const wide = viewportWidth >= 861;
  const page = Math.min(1180, Math.max(0, viewportWidth - (wide ? 32 : 24)));
  const board = wide ? page - 280 - 22 : page;
  return Math.max(1, Math.floor((board + GRID_GAP) / (CARD_MIN + GRID_GAP)));
}

function rowRange(input: {
  top: number;
  viewport: number;
  totalRows: number;
  stride: number;
  overscan: number;
}): { startRow: number; endRow: number } {
  const { top, viewport, totalRows, stride, overscan } = input;
  if (totalRows <= 0 || stride <= 0) return { startRow: 0, endRow: 0 };
  const startRow = Math.min(
    totalRows,
    Math.max(0, Math.floor((-top - overscan * stride) / stride)),
  );
  const endRow = Math.min(totalRows, Math.ceil((viewport - top + overscan * stride) / stride));
  if (endRow <= startRow) return { startRow: 0, endRow: 0 };
  return { startRow, endRow };
}

type SourceStatus = 'idle' | 'loading' | 'ready' | 'error';

function joinLabels(labels: string[]): string {
  if (labels.length < 2) return labels[0] ?? '';
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`;
}

function messageFrom(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return 'A shop took too long to answer.';
  }
  if (error instanceof Error && error.message) return error.message;
  return "Could not reach Dick's catalog.";
}
