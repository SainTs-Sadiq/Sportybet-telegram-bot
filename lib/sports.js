export const SPORTS = {
  football: { key:"football", label:"⚽ Football", sportId:"sr:sport:1" },
  basketball: { key:"basketball", label:"🏀 Basketball", sportId:"sr:sport:2" },
  tennis: { key:"tennis", label:"🎾 Tennis", sportId:"sr:sport:5" }
};

// Temporarily hide basketball and tennis from the menu and aggregate reports until fixtures return reliably.
export const SPORT_ORDER = ["football"];

export function getSport(key) {
  return SPORTS[key] || null;
}

export function sportLabel(key) {
  return SPORTS[key]?.label || key;
}

export function allSportKeys() {
  return [...SPORT_ORDER];
}
