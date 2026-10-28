export const SPORTS = {
  football: { key:"football", label:"⚽ Football", sportId:"sr:sport:1" },
  basketball: { key:"basketball", label:"🏀 Basketball", sportId:"sr:sport:2" },
  tennis: { key:"tennis", label:"🎾 Tennis", sportId:"sr:sport:5" }
};

// Tennis stays hidden: its events appear in the feed but carry no markets
// (verified 2026-10-27 across pc/wap endpoints and market filters).
export const SPORT_ORDER = ["football", "basketball"];

export function getSport(key) {
  return SPORTS[key] || null;
}

export function sportLabel(key) {
  return SPORTS[key]?.label || key;
}

export function allSportKeys() {
  return [...SPORT_ORDER];
}
