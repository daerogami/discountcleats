import { CurrencyPipe, DecimalPipe } from '@angular/common';
import { Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { CatalogSnapshot, DsgCatalog } from '../dsg/catalog';
import {
  BoardFilters,
  DEFAULT_FILTERS,
  FACET,
  GENDER_ORDER,
  SITE_NAME,
  SIZE_FACET,
  SURFACE_ORDER,
  SizeGroup,
  SortKey,
  isSortKey,
  sizeLabel,
  sizeRank,
} from '../dsg/model';
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
  protected readonly sorts: { id: SortKey; label: string }[] = [
    { id: 'price-desc', label: 'Highest price' },
    { id: 'price-asc', label: 'Lowest price' },
    { id: 'discount-desc', label: 'Percent off' },
    { id: 'savings-desc', label: 'Dollars saved' },
    { id: 'rating-desc', label: 'Top rated' },
  ];

  private readonly deals = signal<CatalogSnapshot['deals']>([]);
  private readonly committedFilters = signal<BoardFilters>(this.filters());
  private readonly settled = signal(false);
  protected readonly holdingPrevious = signal(false);
  protected readonly facets = signal<CatalogSnapshot['facets']>({});
  protected readonly total = signal(0);
  protected readonly scanned = signal(0);
  protected readonly capped = signal(false);
  protected readonly status = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly error = signal<string | null>(null);

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
    };
  });
  protected readonly summaryKnown = computed(() => this.settled());
  protected readonly visible = computed(() => selectDeals(this.deals(), this.shownFilters()));
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
  protected readonly surfaceChoices = computed(() =>
    facetChoices(this.facets()[FACET.surface] ?? [], this.filters().surfaces, SURFACE_ORDER),
  );
  protected readonly genderChoices = computed(() =>
    facetChoices(this.facets()[FACET.gender] ?? [], this.filters().genders, GENDER_ORDER),
  );
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

  private request = 0;
  private abort: AbortController | null = null;
  private lastServerKey = '';
  private skipEmptyUrl = this.route.snapshot.queryParamMap.keys.length === 0;
  private pendingUrl = '';

  constructor() {
    effect(() => {
      const filters = this.filters();
      untracked(() => {
        this.remember(filters);
        this.syncUrl(filters);
        const key = serverKey(filters);
        if (key === this.lastServerKey) return;
        this.lastServerKey = key;
        void this.reload(filters, key);
      });
    });

    this.destroyRef.onDestroy(() => this.abort?.abort());

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

  protected reset(): void {
    this.filters.set(sanitize(DEFAULT_FILTERS));
  }

  protected retry(): void {
    const filters = this.filters();
    const key = serverKey(filters);
    this.catalog.forget(key);
    void this.reload(filters, key);
  }

  protected onQuery(event: Event): void {
    this.patch({ query: (event.target as HTMLInputElement).value });
  }

  protected onSort(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    if (isSortKey(value)) this.patch({ sort: value });
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

  private async reload(filters: BoardFilters, key: string): Promise<void> {
    const request = ++this.request;
    this.abort?.abort();
    const hit = this.catalog.cached(key);
    if (hit) {
      this.commit(hit, filters);
      this.status.set('ready');
      this.error.set(null);
      return;
    }

    const hold = this.settled();
    this.holdingPrevious.set(hold);
    const controller = new AbortController();
    this.abort = controller;
    this.status.set('loading');
    this.error.set(null);
    this.total.set(0);
    this.scanned.set(0);

    try {
      await this.catalog.load(
        filters,
        key,
        (snapshot) => {
          if (request !== this.request) return;
          if (!hold || snapshot.done) this.commit(snapshot, filters);
          else {
            this.total.set(snapshot.total);
            this.scanned.set(snapshot.scanned);
          }
          if (snapshot.done) this.status.set('ready');
        },
        controller.signal,
      );
      if (request !== this.request) return;
      this.holdingPrevious.set(false);
      this.status.set('ready');
    } catch (error) {
      if (request !== this.request || controller.signal.aborted) return;
      this.holdingPrevious.set(false);
      this.error.set(messageFrom(error));
      if (hold) {
        this.deals.set([]);
        this.committedFilters.set(filters);
        this.settled.set(false);
        this.status.set('error');
        return;
      }
      this.status.set(this.deals().length ? 'ready' : 'error');
    }
  }

  private commit(snapshot: CatalogSnapshot, filters: BoardFilters): void {
    this.deals.set(snapshot.deals);
    this.facets.set(snapshot.facets);
    this.total.set(snapshot.total);
    this.scanned.set(snapshot.scanned);
    this.capped.set(snapshot.capped);
    this.committedFilters.set(filters);
    this.settled.set(true);
    this.holdingPrevious.set(false);
  }
}

function messageFrom(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') {
    return "Dick's catalog took too long.";
  }
  if (error instanceof Error && error.message) return error.message;
  return "Could not reach Dick's catalog.";
}
