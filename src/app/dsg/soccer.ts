import { Injectable } from '@angular/core';
import { dropCatalog, readCatalog, writeCatalog, CATALOG_CACHE_MS } from './catalog-cache';
import { Listing } from './compare';
import { canonBrandName, surfaceLabel, surfaceToken } from './match';

const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const PAGE_GAP_MS = 300;
export const SOCCER_LISTING_CAP = PAGE_SIZE * MAX_PAGES;
const ENDPOINT = 'https://soccer.rfk.soccer.com/api/search-rec/3';
const ORIGIN = 'https://www.soccer.com';
const SALE_URI = '/shop/products/footwear/sale';
const SOCCER_CACHE_KEY = 'soccer';

interface SearchPage {
  content?: { product?: { value?: SoccerProduct[] } };
}

interface SoccerProduct {
  name?: string;
  sku?: string;
  id?: string;
  url?: string;
  absolute_url?: string;
  image_url?: string;
  image2?: string;
  brands?: string[];
  price?: string | number;
  final_price?: string | number;
  productType?: string;
  category_names?: string[];
  color_desc?: string;
  colors?: unknown;
}

export interface SoccerCatalogResult {
  listings: Listing[];
  capped: boolean;
}

@Injectable({ providedIn: 'root' })
export class SoccerCatalog {
  private cachedResult: { savedAt: number; result: SoccerCatalogResult } | null = null;

  cached(): SoccerCatalogResult | null {
    const hit = this.cachedResult;
    if (!hit) return null;
    if (Date.now() - hit.savedAt > CATALOG_CACHE_MS) {
      this.cachedResult = null;
      return null;
    }
    return hit.result;
  }

  async recall(): Promise<SoccerCatalogResult | null> {
    const live = this.cached();
    if (live) return live;
    const stored = await readCatalog<SoccerCatalogResult>(SOCCER_CACHE_KEY);
    if (!stored) return null;
    this.cachedResult = { savedAt: stored.savedAt, result: stored.payload };
    return stored.payload;
  }

  forget(): void {
    this.cachedResult = null;
    void dropCatalog(SOCCER_CACHE_KEY);
  }

  async load(signal: AbortSignal): Promise<SoccerCatalogResult> {
    const products: SoccerProduct[] = [];
    let capped = false;
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      if (page > 1) await pause(PAGE_GAP_MS, signal);
      const batch = await fetchPage(page, signal);
      products.push(...batch);
      if (batch.length < PAGE_SIZE) break;
      capped = page === MAX_PAGES;
    }
    const result = {
      listings: products.flatMap((product) => toListing(product) ?? []),
      capped,
    };
    const savedAt = Date.now();
    this.cachedResult = { savedAt, result };
    void writeCatalog(SOCCER_CACHE_KEY, result, savedAt);
    return result;
  }
}

async function fetchPage(page: number, signal: AbortSignal): Promise<SoccerProduct[]> {
  const data = {
    context: { page: { uri: SALE_URI } },
    widget: { rfkid: 'rfkid_10' },
    n_item: PAGE_SIZE,
    page_number: page,
    content: { product: {} },
  };
  const url = `${ENDPOINT}?data=${encodeURIComponent(JSON.stringify(data))}`;
  const response = await fetch(url, {
    signal,
    credentials: 'omit',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Soccer.com returned ${response.status}.`);
  const body = (await response.json()) as SearchPage;
  const batch = body.content?.product?.value;
  if (!Array.isArray(batch)) throw new Error('Soccer.com returned an unexpected catalog.');
  return batch;
}

function toListing(product: SoccerProduct): Listing | null {
  const name = text(product.name);
  if (!name) return null;
  const sale = amount(product.final_price);
  const list = amount(product.price);
  const price = sale > 0 ? sale : list;
  if (price <= 0) return null;
  const listPrice = list > price ? list : price;
  const productType = text(product.productType);
  const categories = (product.category_names ?? []).flatMap((value) => {
    const label = text(value);
    return label ? [label] : [];
  });
  const image = absoluteImage(product.image_url);
  const fallback = absoluteImage(product.image2) || image;
  const brand = text(product.brands?.[0]);
  return {
    retailer: 'soccer',
    id: text(product.sku) || text(product.id) || name,
    name,
    brand: canonBrandName(brand),
    url: productUrl(product),
    imageUrl: image,
    fallbackImageUrl: fallback,
    rating: 0,
    ratingCount: 0,
    surface: surfaceFor(productType, name),
    audience: audienceFor(name, categories),
    colors: colorsOf(product),
    productType: isCleat(productType, name) ? 'Cleats' : productType || 'Other',
    serverSized: false,
    reportedDiscount: null,
    variants: [
      {
        mens: null,
        womens: null,
        kids: null,
        price,
        listPrice,
        available: true,
      },
    ],
  };
}

function surfaceFor(productType: string, name: string): string {
  const type = productType.toLowerCase();
  if (type.includes('soft')) return 'Soft Ground';
  if (type.includes('indoor')) return 'Indoor';
  if (type.includes('turf')) return 'Turf';
  if (type.includes('mold')) return 'Molded';
  if (type.includes('firm')) return surfaceLabel(surfaceToken(name)) || 'Firm Ground';
  return surfaceLabel(surfaceToken(name));
}

function isCleat(productType: string, name: string): boolean {
  const type = productType.toLowerCase();
  if (/mystery|bag|lifestyle|running|training/.test(type)) return false;
  if (/shoe|cleat/.test(type)) return true;
  return /cleat/.test(name.toLowerCase());
}

function audienceFor(name: string, categories: readonly string[]): string {
  const text = `${name} ${categories.join(' ')}`.toLowerCase();
  if (/\b(youth|junior|jr|kids|kid's|toddler)\b/.test(text)) return "Boys' · Girls'";
  return "Men's · Women's";
}

function colorsOf(product: SoccerProduct): string[] {
  const described = text(product.color_desc);
  if (described) return [described];
  if (!Array.isArray(product.colors)) return [];
  const first = product.colors.map((value) => text(value)).find((value) => value);
  return first ? [first] : [];
}

function productUrl(product: SoccerProduct): string {
  const absolute = text(product.absolute_url);
  if (absolute.startsWith('http')) return absolute;
  if (absolute.startsWith('//')) return `https:${absolute}`;
  const path = text(product.url) || SALE_URI;
  if (path.startsWith('http')) return path;
  return `${ORIGIN}${path.startsWith('/') ? path : `/${path}`}`;
}

function absoluteImage(value: unknown): string {
  const url = text(value);
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  if (url.startsWith('/')) return `${ORIGIN}${url}`;
  return url;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function amount(value: string | number | undefined): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(signal: AbortSignal): DOMException {
  return signal.reason instanceof DOMException
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}
