import { Injectable } from '@angular/core';
import { dropCatalog, readCatalog, writeCatalog, CATALOG_CACHE_MS } from './catalog-cache';
import { Listing, ListingVariant } from './compare';
import { canonBrandName, surfaceLabel, surfaceToken } from './match';

const PAGE_LIMIT = 250;
const MAX_PAGES = 6;

type ShopifyId = 'prosoccer' | 'unisport';

const SHOPS: Record<ShopifyId, { origin: string; collection: string; label: string }> = {
  prosoccer: {
    origin: 'https://www.prosoccer.com',
    collection: 'footwear-sale',
    label: 'ProSoccer',
  },
  unisport: {
    origin: 'https://www.unisportsoccer.com',
    collection: 'clearance',
    label: 'Unisport',
  },
};

interface ShopifyProduct {
  id?: number;
  title?: string;
  handle?: string;
  vendor?: string;
  product_type?: string;
  options?: { name?: string; values?: string[] }[];
  variants?: ShopifyVariant[];
  images?: { src?: string }[];
}

interface ShopifyVariant {
  price?: string;
  compare_at_price?: string | null;
  available?: boolean;
  option1?: string | null;
  option2?: string | null;
  option3?: string | null;
}

@Injectable({ providedIn: 'root' })
export class ShopifyCatalog {
  private readonly cache = new Map<ShopifyId, { savedAt: number; listings: Listing[] }>();

  cached(id: ShopifyId): Listing[] | null {
    const hit = this.cache.get(id);
    if (!hit) return null;
    if (Date.now() - hit.savedAt > CATALOG_CACHE_MS) {
      this.cache.delete(id);
      return null;
    }
    return hit.listings;
  }

  async recall(id: ShopifyId): Promise<Listing[] | null> {
    const live = this.cached(id);
    if (live) return live;
    const stored = await readCatalog<Listing[]>(shopCacheKey(id));
    if (!stored) return null;
    this.cache.set(id, { savedAt: stored.savedAt, listings: stored.payload });
    return stored.payload;
  }

  forget(id: ShopifyId): void {
    this.cache.delete(id);
    void dropCatalog(shopCacheKey(id));
  }

  async load(id: ShopifyId, signal: AbortSignal): Promise<Listing[]> {
    const shop = SHOPS[id];
    const products: ShopifyProduct[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const url = `${shop.origin}/collections/${shop.collection}/products.json?limit=${PAGE_LIMIT}&page=${page}`;
      const response = await fetch(url, {
        signal,
        credentials: 'omit',
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) {
        throw new Error(`${shop.label} returned ${response.status}.`);
      }
      const body = (await response.json()) as { products?: ShopifyProduct[] };
      const batch = body.products ?? [];
      products.push(...batch);
      if (batch.length < PAGE_LIMIT) break;
    }
    const listings = products.flatMap((product) => toListing(id, shop.origin, product) ?? []);
    const savedAt = Date.now();
    this.cache.set(id, { savedAt, listings });
    void writeCatalog(shopCacheKey(id), listings, savedAt);
    return listings;
  }
}

function shopCacheKey(id: ShopifyId): string {
  return `shopify:${id}`;
}

function toListing(id: ShopifyId, origin: string, product: ShopifyProduct): Listing | null {
  if (!product.title || !product.handle || !product.variants?.length) return null;
  const sizeIndex = sizeOptionIndex(product.options ?? []);
  const variants = product.variants.flatMap(
    (variant) => toVariant(variant, sizeIndex, product.options ?? []) ?? [],
  );
  if (!variants.length) return null;
  const color = colorOption(product.options ?? []);
  const token = surfaceToken(product.title);
  const images = (product.images ?? [])
    .map((image) => image.src)
    .filter((src): src is string => !!src);
  return {
    retailer: id,
    id: String(product.id ?? product.handle),
    name: product.title,
    brand: canonBrandName(product.vendor || ''),
    url: `${origin}/products/${product.handle}`,
    imageUrl: images[0] ?? '',
    fallbackImageUrl: images[1] ?? images[0] ?? '',
    rating: 0,
    ratingCount: 0,
    surface: surfaceLabel(token),
    audience: audienceFor(product.title, variants),
    colors: color ? [color] : [],
    productType: cleatType(product.product_type || '', product.title),
    serverSized: false,
    reportedDiscount: null,
    variants,
  };
}

function toVariant(
  variant: ShopifyVariant,
  sizeIndex: number,
  options: { name?: string }[],
): ListingVariant | null {
  const price = Number(variant.price);
  if (!Number.isFinite(price) || price <= 0) return null;
  const compare = Number(variant.compare_at_price);
  const listPrice = Number.isFinite(compare) && compare > price ? compare : price;
  const optionName = options[sizeIndex]?.name ?? '';
  const optionValue = [variant.option1, variant.option2, variant.option3][sizeIndex] ?? '';
  const sizes = parseSize(optionName, optionValue ?? '');
  return {
    ...sizes,
    price,
    listPrice,
    available: variant.available !== false,
  };
}

function sizeOptionIndex(options: { name?: string }[]): number {
  const index = options.findIndex((option) => /size/i.test(option.name ?? ''));
  return index === -1 ? 0 : index;
}

function colorOption(options: { name?: string; values?: string[] }[]): string {
  const color = options.find((option) => /color/i.test(option.name ?? ''));
  return color?.values?.[0]?.trim() ?? '';
}

function parseSize(
  optionName: string,
  value: string,
): Pick<ListingVariant, 'mens' | 'womens' | 'kids'> {
  const empty = { mens: null, womens: null, kids: null };
  const name = optionName.toLowerCase();
  const text = value.trim();
  const pair = text.match(/^M\s*(\d+(?:\.\d+)?)\s*\/\s*W\s*(\d+(?:\.\d+)?)/i);
  if (pair) return { mens: Number(pair[1]), womens: Number(pair[2]), kids: null };
  const youth = text.match(/^(\d+(?:\.\d+)?)K$/i);
  if (youth) return { mens: null, womens: null, kids: Number(youth[1]) };
  const bare = text.match(/^(\d+(?:\.\d+)?)$/);
  if (!bare) return empty;
  const amount = Number(bare[1]);
  if (/kid|youth|junior|child/.test(name)) return { mens: null, womens: null, kids: amount };
  if (/adult|men|women|size/.test(name)) return { mens: amount, womens: null, kids: null };
  return empty;
}

function audienceFor(title: string, variants: ListingVariant[]): string {
  const text = title.toLowerCase();
  const kidsTitle = /\b(kids|kid's|junior|jr|youth)\b/.test(text);
  const onlyKids = variants.every(
    (variant) => variant.kids != null && variant.mens == null && variant.womens == null,
  );
  if (kidsTitle || onlyKids) return "Boys' · Girls'";
  return "Men's · Women's";
}

function cleatType(productType: string, title: string): string {
  const text = `${productType} ${title}`.toLowerCase();
  if (/ball|jersey|jacket|short|sock|bag|glove|shirt|hoodie|pant/.test(productType.toLowerCase())) {
    return productType;
  }
  if (/cleat|soccer shoe|footwear|\bshoes?\b/.test(text)) return 'Cleats';
  return productType || 'Other';
}
