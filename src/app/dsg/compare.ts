import { BoardFilters, Deal, RetailerId, activeAudiences, matchesAudiences } from './model';
import { canonBrandName } from './match';

export interface ListingVariant {
  mens: number | null;
  womens: number | null;
  kids: number | null;
  price: number;
  listPrice: number;
  available: boolean;
}

export interface Listing {
  retailer: RetailerId;
  id: string;
  name: string;
  brand: string;
  url: string;
  imageUrl: string;
  fallbackImageUrl: string;
  rating: number;
  ratingCount: number;
  surface: string;
  audience: string;
  colors: string[];
  productType: string;
  /** Dick's has already limited this listing to the requested size. */
  serverSized: boolean;
  reportedDiscount: number | null;
  variants: ListingVariant[];
}

interface PricedListing {
  listing: Listing;
  price: number;
  listPrice: number;
  discount: number;
  savings: number;
}

export function listingFromDeal(deal: Deal): Listing {
  return {
    retailer: 'dicks',
    id: deal.id,
    name: deal.name,
    brand: deal.brand,
    url: deal.url,
    imageUrl: deal.imageUrl,
    fallbackImageUrl: deal.fallbackImageUrl,
    rating: deal.rating,
    ratingCount: deal.ratingCount,
    surface: deal.surface,
    audience: deal.audience,
    colors: deal.colors,
    productType: '',
    serverSized: true,
    reportedDiscount: deal.discount,
    variants: [
      {
        mens: null,
        womens: null,
        kids: null,
        price: deal.price,
        listPrice: deal.listPrice,
        available: true,
      },
    ],
  };
}

export function buildDeals(listings: readonly Listing[], filters: BoardFilters): Deal[] {
  const deals: Deal[] = [];
  for (const listing of listings) {
    const priced = priceListing(listing, filters);
    if (!priced) continue;
    const deal = dealFrom(priced, filters);
    if (deal) deals.push(deal);
  }
  return deals;
}

function priceListing(listing: Listing, filters: BoardFilters): PricedListing | null {
  if (!passesShelf(listing, filters)) return null;
  const money = choosePrice(listing, filters);
  if (!money) return null;
  const listPrice = money.listPrice >= money.price ? money.listPrice : money.price;
  const savings = Math.max(0, Math.round(listPrice - money.price));
  const computed = listPrice > 0 ? Math.max(0, ((listPrice - money.price) / listPrice) * 100) : 0;
  const discount =
    listing.serverSized && listing.reportedDiscount != null ? listing.reportedDiscount : computed;
  return { listing, price: money.price, listPrice, discount, savings };
}

function passesShelf(listing: Listing, filters: BoardFilters): boolean {
  if (listing.serverSized) return true;
  if (
    filters.productTypes.length &&
    listing.productType &&
    !filters.productTypes.includes(listing.productType)
  ) {
    return false;
  }
  if (filters.brands.length) {
    const brand = listing.brand.toLowerCase();
    if (!filters.brands.some((value) => value.toLowerCase() === brand)) return false;
  }
  if (filters.surfaces.length && !filters.surfaces.includes(listing.surface)) return false;
  return matchesAudiences(listing.audience, activeAudiences(filters));
}

function choosePrice(
  listing: Listing,
  filters: BoardFilters,
): { price: number; listPrice: number } | null {
  if (listing.serverSized) {
    const variant = listing.variants[0];
    if (!variant || variant.price <= 0) return null;
    return { price: variant.price, listPrice: variant.listPrice };
  }

  let variants = listing.variants.filter((variant) => variant.available);
  if (!variants.length) return null;
  if (filters.size && filters.sizeGroup !== 'all') {
    const target = sizeNumber(filters.size);
    variants = variants.filter((variant) => {
      if (filters.sizeGroup === 'mens') return near(variant.mens, target);
      if (filters.sizeGroup === 'womens') return near(variant.womens, target);
      return near(variant.kids, target);
    });
  } else if (filters.sizeGroup === 'mens') {
    const mens = variants.filter((variant) => variant.mens != null);
    if (mens.length) variants = mens;
  } else if (filters.sizeGroup === 'womens') {
    const womens = variants.filter((variant) => variant.womens != null);
    if (womens.length) variants = womens;
  } else if (filters.sizeGroup === 'kids') {
    const kids = variants.filter((variant) => variant.kids != null);
    if (kids.length) variants = kids;
  } else {
    const adult = variants.filter((variant) => variant.mens != null || variant.womens != null);
    if (adult.length) variants = adult;
  }
  if (!variants.length) return null;
  const best = variants.reduce((lowest, variant) =>
    variant.price < lowest.price ? variant : lowest,
  );
  return { price: best.price, listPrice: best.listPrice };
}

function dealFrom(item: PricedListing, filters: BoardFilters): Deal | null {
  if (item.discount < filters.minDiscount) return null;
  if (filters.maxPrice != null && item.price > filters.maxPrice) return null;
  return {
    id: `${item.listing.retailer}:${item.listing.id}`,
    retailer: item.listing.retailer,
    name: item.listing.name,
    brand: canonBrandName(item.listing.brand),
    url: item.listing.url,
    imageUrl: item.listing.imageUrl,
    fallbackImageUrl: item.listing.fallbackImageUrl,
    listPrice: item.listPrice,
    price: item.price,
    savings: item.savings,
    discount: item.discount,
    rating: item.listing.rating,
    ratingCount: item.listing.ratingCount,
    surface: item.listing.surface,
    audience: item.listing.audience,
    colors: item.listing.colors,
  };
}

function sizeNumber(value: string): number {
  return Number.parseFloat(value);
}

function near(value: number | null, target: number): boolean {
  return value != null && Number.isFinite(target) && Math.abs(value - target) < 0.01;
}
