const BRAND_LABELS: Record<string, string> = {
  nike: 'Nike',
  adidas: 'adidas',
  puma: 'Puma',
  'new balance': 'New Balance',
  mizuno: 'Mizuno',
  skechers: 'Skechers',
  diadora: 'Diadora',
  'under armour': 'Under Armour',
  lotto: 'Lotto',
  joma: 'Joma',
  charly: 'Charly',
  jordan: 'Jordan',
};

const SURFACE_LABEL: Record<string, string> = {
  fg: 'Firm Ground',
  mg: 'Firm Ground',
  fgag: 'Artificial Grass',
  ag: 'Artificial Grass',
  tf: 'Turf',
  ic: 'Indoor',
  sg: 'Soft Ground',
  molded: 'Molded',
};

export function canonBrandName(raw: string): string {
  const lower = raw.trim().toLowerCase();
  return BRAND_LABELS[lower] ?? raw.trim();
}

export function surfaceToken(value: string): string {
  const text = value.toLowerCase();
  if (!text.trim()) return '';
  if (/firm\s*\/\s*multi|multi[\s-]*ground|\bfg\/mg\b/.test(text)) return 'mg';
  if (/firm\s*\/\s*artificial|\bfg\/ag\b/.test(text)) return 'fgag';
  if (/mold/.test(text)) return 'molded';
  if (/firm ground|\bfg\b/.test(text)) return 'fg';
  if (/artificial|\bag\b/.test(text)) return 'ag';
  if (/turf|\btf\b/.test(text)) return 'tf';
  if (/indoor|\bic\b/.test(text)) return 'ic';
  if (/soft ground|\bsg\b/.test(text)) return 'sg';
  return '';
}

export function surfaceLabel(token: string): string {
  return SURFACE_LABEL[token] ?? '';
}
