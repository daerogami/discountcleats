import { ParamMap, Params } from '@angular/router';
import {
  BoardFilters,
  DEFAULT_FILTERS,
  Deal,
  FacetValue,
  SortKey,
  activeAudiences,
  isSizeGroup,
  isSortKey,
  matchesAudiences,
} from './model';

export const STORAGE_KEY = 'discountcleats.board';

export function sanitize(input: Partial<BoardFilters> | null | undefined): BoardFilters {
  const source = input ?? {};
  const minDiscount = clamp(numberOr(source.minDiscount, DEFAULT_FILTERS.minDiscount), 0, 80);
  const maxPrice = cleanMaxPrice(source.maxPrice);
  const sort =
    typeof source.sort === 'string' && isSortKey(source.sort) ? source.sort : DEFAULT_FILTERS.sort;
  const sizeGroup =
    typeof source.sizeGroup === 'string' && isSizeGroup(source.sizeGroup)
      ? source.sizeGroup
      : DEFAULT_FILTERS.sizeGroup;
  const size = typeof source.size === 'string' && source.size.trim() ? source.size.trim() : null;
  const zip =
    typeof source.zip === 'string' && /^\d{5}$/.test(source.zip) ? source.zip : DEFAULT_FILTERS.zip;
  const storeNumber =
    typeof source.storeNumber === 'string' && /^\d{1,12}$/.test(source.storeNumber.trim())
      ? source.storeNumber.trim()
      : DEFAULT_FILTERS.storeNumber;
  const storeIdValue = numberOr(source.storeId, DEFAULT_FILTERS.storeId);
  const storeId =
    Number.isInteger(storeIdValue) && storeIdValue > 0 ? storeIdValue : DEFAULT_FILTERS.storeId;

  return {
    minDiscount,
    maxPrice,
    sort,
    query: typeof source.query === 'string' ? source.query.slice(0, 80) : '',
    productTypes: Array.isArray(source.productTypes)
      ? uniqueStrings(source.productTypes)
      : [...DEFAULT_FILTERS.productTypes],
    brands: uniqueStrings(source.brands),
    surfaces: uniqueStrings(source.surfaces),
    genders: uniqueStrings(source.genders),
    sizeGroup,
    size,
    zip,
    storeNumber,
    storeId,
  };
}

export function filtersFromParams(map: ParamMap): BoardFilters {
  const types = map.getAll('type');
  let productTypes: string[] | undefined;
  if (types.length === 1 && types[0] === 'all') productTypes = [];
  else if (types.length > 0) productTypes = types;

  const off = map.get('off');
  const max = map.get('max');
  const storeId = map.get('storeId');

  return sanitize({
    minDiscount: off == null ? undefined : Number(off),
    maxPrice: max == null ? undefined : Number(max),
    sort: (map.get('sort') ?? undefined) as SortKey | undefined,
    query: map.get('q') ?? undefined,
    productTypes,
    brands: map.getAll('brand'),
    surfaces: map.getAll('surface'),
    genders: map.getAll('gender'),
    sizeGroup: (map.get('fit') ??
      (map.get('size') ? 'mens' : undefined)) as BoardFilters['sizeGroup'],
    size: map.get('size'),
    zip: map.get('zip') ?? undefined,
    storeNumber: map.get('store') ?? undefined,
    storeId: storeId == null ? undefined : Number(storeId),
  });
}

export function serializeFilters(filters: BoardFilters): Params {
  const params: Params = {};
  if (filters.minDiscount !== DEFAULT_FILTERS.minDiscount) params['off'] = filters.minDiscount;
  if (filters.maxPrice != null) params['max'] = filters.maxPrice;
  if (filters.sort !== DEFAULT_FILTERS.sort) params['sort'] = filters.sort;
  if (filters.query.trim()) params['q'] = filters.query.trim();
  if (filters.productTypes.length === 0) params['type'] = 'all';
  else if (!sameList(filters.productTypes, DEFAULT_FILTERS.productTypes))
    params['type'] = filters.productTypes;
  if (filters.brands.length) params['brand'] = filters.brands;
  if (filters.surfaces.length) params['surface'] = filters.surfaces;
  if (filters.genders.length) params['gender'] = filters.genders;
  if (filters.sizeGroup !== DEFAULT_FILTERS.sizeGroup) params['fit'] = filters.sizeGroup;
  if (filters.size) params['size'] = filters.size;
  if (filters.zip !== DEFAULT_FILTERS.zip) params['zip'] = filters.zip;
  if (filters.storeNumber !== DEFAULT_FILTERS.storeNumber) params['store'] = filters.storeNumber;
  if (filters.storeId !== DEFAULT_FILTERS.storeId) params['storeId'] = filters.storeId;
  return params;
}

export function canonicalQuery(params: Params): string {
  const search = new URLSearchParams();
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value == null) continue;
    const list = (Array.isArray(value) ? value.map(String) : [String(value)]).sort();
    for (const item of list) search.append(key, item);
  }
  return search.toString();
}

export function canonicalMap(map: ParamMap): string {
  const search = new URLSearchParams();
  for (const key of [...map.keys].sort()) {
    for (const value of [...map.getAll(key)].sort()) search.append(key, value);
  }
  return search.toString();
}

export function sameFilters(a: BoardFilters, b: BoardFilters): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function serverKey(filters: BoardFilters): string {
  return JSON.stringify({
    productTypes: filters.productTypes,
    brands: filters.brands,
    surfaces: filters.surfaces,
    genders: filters.genders,
    sizeGroup: filters.sizeGroup,
    size: filters.size,
    zip: filters.zip,
    storeNumber: filters.storeNumber,
    storeId: filters.storeId,
  });
}

export function readStoredFilters(): BoardFilters | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return sanitize(JSON.parse(raw) as Partial<BoardFilters>);
  } catch {
    return null;
  }
}

export function selectDeals(deals: readonly Deal[], filters: BoardFilters): Deal[] {
  const query = filters.query.trim().toLowerCase();
  const maxPrice = filters.maxPrice;
  const next = deals.filter((deal) => {
    if (deal.discount < filters.minDiscount) return false;
    if (!matchesAudiences(deal.audience, activeAudiences(filters))) return false;
    if (maxPrice != null && deal.price > maxPrice) return false;
    if (!query) return true;
    const haystack =
      `${deal.brand} ${deal.name} ${deal.surface} ${deal.audience} ${deal.colors.join(' ')}`.toLowerCase();
    return haystack.includes(query);
  });
  next.sort((a, b) => compareDeals(a, b, filters.sort) || a.name.localeCompare(b.name));
  return next;
}

export function facetChoices(
  values: readonly FacetValue[],
  selected: readonly string[],
  order?: readonly string[],
): FacetValue[] {
  const byName = new Map(values.map((value) => [value.value, value]));
  for (const name of selected) {
    if (!byName.has(name)) byName.set(name, { value: name, count: 0 });
  }
  const list = [...byName.values()];
  list.sort((a, b) => {
    if (order) {
      const ai = order.indexOf(a.value);
      const bi = order.indexOf(b.value);
      const ar = ai === -1 ? order.length : ai;
      const br = bi === -1 ? order.length : bi;
      if (ar !== br) return ar - br;
    }
    return b.count - a.count || a.value.localeCompare(b.value);
  });
  return list;
}

function compareDeals(a: Deal, b: Deal, sort: SortKey): number {
  switch (sort) {
    case 'price-asc':
      return a.price - b.price;
    case 'discount-desc':
      return b.discount - a.discount || b.savings - a.savings;
    case 'savings-desc':
      return b.savings - a.savings || b.discount - a.discount;
    case 'rating-desc':
      return b.rating - a.rating || b.ratingCount - a.ratingCount;
    case 'price-desc':
      return b.price - a.price || b.discount - a.discount;
  }
}

function uniqueStrings(values: readonly unknown[] | undefined): string[] {
  if (!values) return [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > 80) continue;
    seen.add(trimmed);
    if (seen.size >= 24) break;
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function numberOr(value: unknown, fallback: number): number {
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cleanMaxPrice(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.min(parsed, 2000);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
