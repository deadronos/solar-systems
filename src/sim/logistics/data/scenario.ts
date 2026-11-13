import { START_JD } from '../core/time.ts';
import type { ScenarioConfig } from '../economy/types.ts';
import { ECONOMY_CONSTANTS } from './economyConstants.ts';
import { GOODS } from './goods.ts';
import { COMPANIES, PERSONALITIES } from './personalities.ts';
import { RECIPES } from './recipes.ts';
import { SETTLEMENTS } from './settlements.ts';
import { SHIP_CLASSES } from './shipClasses.ts';

/** The default near-future scenario (2040). */
export const DEFAULT_SCENARIO: ScenarioConfig = {
  seed: 2040,
  startJd: START_JD,
  goods: GOODS,
  recipes: RECIPES,
  settlements: SETTLEMENTS,
  shipClasses: SHIP_CLASSES,
  personalities: PERSONALITIES,
  companies: COMPANIES,
  constants: ECONOMY_CONSTANTS,
};
