import { Injectable } from '@angular/core';
import {
  dropCatalog,
  pruneCatalog,
  readCatalog,
  writeCatalog,
  CATALOG_CACHE_MS,
} from './catalog-cache';
import {
  BoardFilters,
  Deal,
  FacetValue,
  SIZE_FACET,
  SOCCER_SALE_CATEGORY,
  activeAudiences,
} from './model';

const API = 'https://prod-catalog-product-api.dickssportinggoods.com/v2/search';
const IMAGE_BASE = 'https://dks.scene7.com/is/image/dkscdn/';
const PAGE_SIZE = 120;
const CONCURRENCY = 4;
const MAX_PAGES = 20;

export interface CatalogSnapshot {
  deals: Deal[];
  total: number;
  scanned: number;
  facets: Readonly<Record<string, FacetValue[]>>;
  done: boolean;
  capped: boolean;
}

interface SearchResponse {
  totalCount?: number;
  productVOs?: ProductVo[];
  productDetails?: Record<string, ProductDetail>;
  facetVOs?: FacetVo[];
}

interface ProductVo {
  catentryId?: number | string;
  parentCatentryId?: number | string;
  parentPartnumber?: string;
  swatchPartnumber?: string;
  name?: string;
  mfName?: string;
  fullImage?: string;
  dsgSeoUrl?: string;
  attributes?: string;
  dsgPriceIndicators?: { dealsPercentage?: number };
  ratingValue?: number;
  ratingCount?: number;
  isComingSoon?: boolean;
}

interface ProductDetail {
  prices?: {
    maxlistprice?: string;
    minofferprice?: string;
  };
  skuAttributes?: { Color?: string[] };
}

interface FacetVo {
  attrIdentifier?: string;
  valueList?: { value?: string; count?: number }[];
}

@Injectable({ providedIn: 'root' })
export class DsgCatalog {
  private readonly cache = new Map<string, { savedAt: number; snapshot: CatalogSnapshot }>();

  cached(key: string): CatalogSnapshot | null {
    const hit = this.cache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.savedAt > CATALOG_CACHE_MS) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, hit);
    return hit.snapshot;
  }

  async recall(key: string): Promise<CatalogSnapshot | null> {
    const live = this.cached(key);
    if (live) return live;
    const stored = await readCatalog<CatalogSnapshot>(dicksCacheKey(key));
    if (!stored) return null;
    this.keep(key, stored.payload, stored.savedAt);
    return stored.payload;
  }

  forget(key: string): void {
    this.cache.delete(key);
    void dropCatalog(dicksCacheKey(key));
  }

  async load(
    filters: BoardFilters,
    key: string,
    onProgress: (snapshot: CatalogSnapshot) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const first = await this.fetchPage(filters, 0, signal);
    const total = first.total;
    const pageCount = Math.min(MAX_PAGES, Math.max(1, Math.ceil(total / PAGE_SIZE)));
    const capped = total > pageCount * PAGE_SIZE;
    const facets = first.facets;
    let deals = first.deals;
    let scanned = first.received;

    const publish = (done: boolean) => {
      onProgress({
        deals: deals.slice(),
        total,
        scanned: Math.min(total, scanned),
        facets,
        done,
        capped,
      });
    };

    publish(pageCount <= 1);
    if (pageCount <= 1) {
      this.remember(key, {
        deals,
        total,
        scanned: Math.min(total, scanned),
        facets,
        done: true,
        capped,
      });
      return;
    }

    let cursor = 1;
    const workers = Array.from({ length: Math.min(CONCURRENCY, pageCount - 1) }, async () => {
      while (!signal.aborted) {
        const pageNumber = cursor++;
        if (pageNumber >= pageCount) return;
        const page = await this.fetchPage(filters, pageNumber, signal);
        deals = dedupe(deals.concat(page.deals));
        scanned += page.received;
        publish(false);
      }
    });

    await Promise.all(workers);
    if (signal.aborted) return;

    const snapshot: CatalogSnapshot = {
      deals,
      total,
      scanned: Math.min(total, scanned),
      facets,
      done: true,
      capped,
    };
    this.remember(key, snapshot);
    onProgress({ ...snapshot, deals: deals.slice() });
  }

  private remember(key: string, snapshot: CatalogSnapshot): void {
    const savedAt = Date.now();
    this.keep(key, snapshot, savedAt);
    void writeCatalog(dicksCacheKey(key), snapshot, savedAt).then(() => pruneCatalog('dicks:', 6));
  }

  private keep(key: string, snapshot: CatalogSnapshot, savedAt: number): void {
    this.cache.delete(key);
    this.cache.set(key, { savedAt, snapshot });
    while (this.cache.size > 6) {
      const oldest = this.cache.keys().next().value;
      if (!oldest) break;
      this.cache.delete(oldest);
    }
  }

  private async fetchPage(
    filters: BoardFilters,
    pageNumber: number,
    signal: AbortSignal,
  ): Promise<PageResult> {
    const url = `${API}?searchVO=${encodeURIComponent(JSON.stringify(buildSearch(filters, pageNumber)))}`;
    const timeout = AbortSignal.timeout(20000);
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, timeout]),
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      throw new Error(
        response.status === 403
          ? "Dick's catalog blocked this request. Wait a minute and try again."
          : `Dick's catalog returned ${response.status}.`,
      );
    }
    let body: SearchResponse;
    try {
      body = (await response.json()) as SearchResponse;
    } catch {
      throw new Error("Dick's catalog didn't return product data.");
    }
    const products = body.productVOs ?? [];
    return {
      deals: mapDeals(body),
      received: products.length,
      total: typeof body.totalCount === 'number' ? body.totalCount : products.length,
      facets: pageNumber === 0 ? indexFacets(body.facetVOs ?? []) : {},
    };
  }
}

interface PageResult {
  deals: Deal[];
  received: number;
  total: number;
  facets: Record<string, FacetValue[]>;
}

function dicksCacheKey(key: string): string {
  return `dicks:${key}`;
}

function buildSearch(filters: BoardFilters, pageNumber: number) {
  const selectedFilters: Record<string, string[]> = {};
  if (filters.productTypes.length) selectedFilters['5382'] = filters.productTypes;
  if (filters.brands.length) selectedFilters['X_BRAND'] = filters.brands;
  if (filters.surfaces.length) selectedFilters['2234'] = filters.surfaces;
  const audiences = activeAudiences(filters);
  if (audiences.length) selectedFilters['5495'] = [...audiences];
  if (filters.size && filters.sizeGroup !== 'all') {
    selectedFilters[SIZE_FACET[filters.sizeGroup]] = [filters.size];
  }

  return {
    selectedCategory: SOCCER_SALE_CATEGORY,
    selectedStore: filters.storeNumber,
    selectedSort: 2,
    selectedFilters,
    storeId: filters.storeId,
    pageNumber,
    pageSize: PAGE_SIZE,
    searchTypes: ['SKU_COLLECTION', 'RISA'],
    isFamilyPage: true,
    snbAudience: '',
    zipcode: filters.zip,
  };
}

function mapDeals(body: SearchResponse): Deal[] {
  const details = body.productDetails ?? {};
  const deals: Deal[] = [];
  for (const product of body.productVOs ?? []) {
    const detail =
      details[String(product.parentCatentryId ?? '')] ?? details[String(product.catentryId ?? '')];
    const deal = toDeal(product, detail);
    if (deal) deals.push(deal);
  }
  return deals;
}

function toDeal(product: ProductVo, detail: ProductDetail | undefined): Deal | null {
  if (!product.name || !product.dsgSeoUrl || product.isComingSoon || !detail?.prices) return null;
  const listPrice = Number(detail.prices.maxlistprice);
  const price = Number(detail.prices.minofferprice);
  if (!Number.isFinite(listPrice) || !Number.isFinite(price) || price <= 0) return null;

  const part = product.parentPartnumber || product.fullImage || '';
  const swatch = (product.swatchPartnumber || '').replaceAll('/', '_').replaceAll(' ', '_');
  const primary = swatch || `${part}_is`;
  const fallback = `${part}_is`;
  const reported = product.dsgPriceIndicators?.dealsPercentage;
  const computed = listPrice > 0 ? ((listPrice - price) / listPrice) * 100 : 0;
  const discount = Math.max(0, typeof reported === 'number' ? reported : computed);

  return {
    id: String(product.parentCatentryId || product.catentryId || product.dsgSeoUrl),
    retailer: 'dicks',
    name: product.name,
    brand: product.mfName || '',
    url: `https://www.dickssportinggoods.com${product.dsgSeoUrl}`,
    imageUrl: imageUrl(primary),
    fallbackImageUrl: imageUrl(fallback),
    listPrice,
    price,
    savings: Math.max(0, Math.round(listPrice - price)),
    discount,
    rating: product.ratingValue ?? 0,
    ratingCount: product.ratingCount ?? 0,
    surface: attributeValues(product.attributes, '2234')[0] ?? '',
    audience: attributeValues(product.attributes, '5495').join(' · '),
    colors: detail.skuAttributes?.Color ?? [],
  };
}

function imageUrl(asset: string): string {
  return `${IMAGE_BASE}${encodeURIComponent(asset)}?wid=480&hei=480&qlt=70&fmt=webp`;
}

function attributeValues(raw: string | undefined, key: string): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const values: string[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const value = (entry as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) values.push(value);
    }
    return [...new Set(values)];
  } catch {
    return [];
  }
}

function indexFacets(facets: FacetVo[]): Record<string, FacetValue[]> {
  const record: Record<string, FacetValue[]> = {};
  for (const facet of facets) {
    if (!facet.attrIdentifier) continue;
    record[facet.attrIdentifier] = (facet.valueList ?? [])
      .filter(
        (value): value is { value: string; count?: number } => typeof value.value === 'string',
      )
      .map((value) => ({ value: value.value, count: value.count ?? 0 }));
  }
  return record;
}

function dedupe(deals: Deal[]): Deal[] {
  const seen = new Set<string>();
  const result: Deal[] = [];
  for (const deal of deals) {
    if (seen.has(deal.id)) continue;
    seen.add(deal.id);
    result.push(deal);
  }
  return result;
}
