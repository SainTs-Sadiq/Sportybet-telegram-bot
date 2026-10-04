export const MARKET_CATALOGUE = [
  ["1","1X2"],["10","Double Chance"],["11","Draw No Bet"],["14","Handicap"],["18","Over/Under"],
  ["21","Exact Goals"],["25","Goal Range"],["26","Odd/Even"],["29","GG/NG"],["30","Teams to Score"],
  ["35","1X2 & GG/NG"],["36","Over/Under & GG/NG"],["45","Correct Score"],["47","Half Time/Full Time"],
  ["52","Highest Scoring Half"],["60","1st Half - 1X2"],["63","1st Half - Double Chance"],["68","1st Half - Over/Under"],
  ["81","1st Half - Correct Score"],["83","2nd Half - 1X2"],["90","2nd Half - Over/Under"],["98","2nd Half - Correct Score"],
  ["162","Corners - 1X2"],["163","1st Corner"],["164","Last Corner"],["165","Corner Handicap"],["166","Corners - Over/Under"],
  ["172","Odd/Even Corners"],["184","1st Goal & 1X2"]
];
export const MARKET_IDS = MARKET_CATALOGUE.map(([id]) => id);
export const MARKET_NAMES = Object.fromEntries(MARKET_CATALOGUE);