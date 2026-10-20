export const SITE_NAME = 'Discount Cleats';

export const SOCCER_SALE_CATEGORY = '12301_10599206';

export const FACET = {
  gender: '5495',
  productType: '5382',
  surface: '2234',
  brand: 'X_BRAND',
  mensSize: '5212',
  womensSize: '5213',
  kidsSize: '5214',
} as const;

export const SURFACE_ORDER = [
  'Firm Ground',
  'Turf',
  'Indoor',
  'Artificial Grass',
  'Soft Ground',
  'Molded',
] as const;

export const GENDER_ORDER = ["Men's", "Women's", "Boys'", "Girls'", 'Unisex'] as const;

export type SizeGroup = 'all' | 'mens' | 'womens' | 'kids';

export const SIZE_FACET: Record<Exclude<SizeGroup, 'all'>, string> = {
  mens: FACET.mensSize,
  womens: FACET.womensSize,
  kids: FACET.kidsSize,
};

const SIZE_GROUP_AUDIENCE = {
  mens: ["Men's"],
  womens: ["Women's"],
  kids: ["Boys'", "Girls'"],
} as const satisfies Record<Exclude<SizeGroup, 'all'>, readonly string[]>;

export type SortKey = 'price-desc' | 'price-asc' | 'discount-desc' | 'savings-desc' | 'rating-desc';

export interface Deal {
  id: string;
  name: string;
  brand: string;
  url: string;
  imageUrl: string;
  fallbackImageUrl: string;
  listPrice: number;
  price: number;
  savings: number;
  discount: number;
  rating: number;
  ratingCount: number;
  surface: string;
  audience: string;
  colors: string[];
}

export interface FacetValue {
  value: string;
  count: number;
}

export interface BoardFilters {
  minDiscount: number;
  maxPrice: number | null;
  sort: SortKey;
  query: string;
  productTypes: string[];
  brands: string[];
  surfaces: string[];
  genders: string[];
  sizeGroup: SizeGroup;
  size: string | null;
  zip: string;
  storeNumber: string;
  storeId: number;
}

export const DEFAULT_FILTERS: BoardFilters = {
  minDiscount: 50,
  maxPrice: null,
  sort: 'discount-desc',
  query: '',
  productTypes: ['Cleats'],
  brands: [],
  surfaces: [],
  genders: [],
  sizeGroup: 'all',
  size: null,
  zip: '37923',
  storeNumber: '4435',
  storeId: 15108,
};

export function isSortKey(value: string): value is SortKey {
  return (
    value === 'price-desc' ||
    value === 'price-asc' ||
    value === 'discount-desc' ||
    value === 'savings-desc' ||
    value === 'rating-desc'
  );
}

export function isSizeGroup(value: string): value is SizeGroup {
  return value === 'all' || value === 'mens' || value === 'womens' || value === 'kids';
}

export function audiencesFor(group: SizeGroup): readonly string[] {
  if (group === 'all') return [];
  return SIZE_GROUP_AUDIENCE[group];
}

export function activeAudiences(
  filters: Pick<BoardFilters, 'genders' | 'sizeGroup'>,
): readonly string[] {
  if (filters.genders.length) return filters.genders;
  return audiencesFor(filters.sizeGroup);
}

export function matchesAudiences(audience: string, wanted: readonly string[]): boolean {
  if (!wanted.length) return true;
  const parts = new Set(audience.split(' · '));
  return wanted.some((value) => parts.has(value));
}

export function sizeLabel(value: string): string {
  return value.replace(/\.0(?=K?$)/, '');
}

export function sizeRank(value: string): number {
  const youth = value.endsWith('K');
  const parsed = Number.parseFloat(value);
  const n = Number.isFinite(parsed) ? parsed : 999;
  return youth ? n - 100 : n;
}
