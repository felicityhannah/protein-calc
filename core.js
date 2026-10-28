/**
 * ProNeed's framework-independent calculations and migration helpers.
 * Guidance: ISSN position stand, https://doi.org/10.1186/s12970-017-0177-8
 * NIH overview: https://ods.od.nih.gov/factsheets/ExerciseAndAthleticPerformance-HealthProfessional/
 * 1.4 / 1.6 / 1.8 are transparent product starting points WITHIN the ISSN
 * 1.4–2.0 g/kg exercising-adult range, not separate clinical prescriptions.
 */

export const GOALS = Object.freeze({
  maintain: Object.freeze({ id: 'maintain', label: 'Stay consistent', perKg: 1.4, minPerKg: 1.4, maxPerKg: 2.0, description: 'A lower starting point within the exercising-adult range.' }),
  build: Object.freeze({ id: 'build', label: 'Build muscle', perKg: 1.6, minPerKg: 1.4, maxPerKg: 2.0, description: 'A middle starting point within the exercising-adult range.' }),
  lose: Object.freeze({ id: 'lose', label: 'Lose fat, keep muscle', perKg: 1.8, minPerKg: 1.4, maxPerKg: 2.0, description: 'A higher starting point within the exercising-adult range; not an individual weight-loss prescription.' }),
});

const FOOD_SOURCE = 'https://fdc.nal.usda.gov/';
const food = (id, name, emoji, p100, serving, state, vegetarian = true, unit = 'g') => Object.freeze({
  id, name, emoji, p100, serving, unit, state, vegetarian,
  portionLabel: `${serving}${unit}`,
  source: FOOD_SOURCE,
  sourceNote: 'Illustrative rounded protein estimate. Products and preparation vary; use your food label for tracking.',
});

// These are illustrative, rounded examples, not a verified branded-food database.
// The state is part of the name: raw and cooked weights are not interchangeable.
export const FOODS = Object.freeze([
  food('chicken', 'Chicken breast (cooked, skinless)', '🍗', 31, 120, 'cooked', false),
  food('tuna', 'Tuna (canned in water, drained)', '🐟', 26, 100, 'drained', false),
  food('eggs', 'Whole eggs (hard-boiled, peeled)', '🥚', 13, 100, 'cooked'),
  food('yogurt', 'Greek yogurt (plain, nonfat)', '🥣', 10, 200, 'as sold'),
  food('cottage', 'Cottage cheese (low fat)', '🧀', 11, 150, 'as sold'),
  food('tofu', 'Firm tofu (drained)', '🧊', 14, 150, 'drained'),
  food('lentils', 'Lentils (cooked, drained)', '🫘', 9, 150, 'cooked'),
  food('chickpeas', 'Chickpeas (cooked, drained)', '🫘', 9, 150, 'cooked'),
  food('edamame', 'Edamame (cooked, shelled)', '🫛', 12, 100, 'cooked'),
  food('oats', 'Rolled oats (dry)', '🌾', 13, 50, 'dry'),
  food('milk', 'Milk (reduced fat)', '🥛', 3.4, 250, 'as sold', true, 'ml'),
  food('peanut', 'Peanut butter', '🥜', 25, 20, 'as sold'),
]);

const round1 = value => Math.round((value + Number.EPSILON) * 10) / 10;
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function numeric(value, field) {
  if (typeof value !== 'number' && typeof value !== 'string') throw new TypeError(`${field} is required.`);
  if (typeof value === 'string' && value.trim() === '') throw new TypeError(`${field} is required.`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${field} must be a finite number.`);
  return number;
}

function validDateString(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year < 1900 || year > 9999) return false;
  // Noon avoids DST gaps around midnight in historical calendar conversions.
  const parsed = new Date(year, month - 1, day, 12);
  return parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day;
}

export function localDate(date = new Date()) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new TypeError('A valid date is required.');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Convert display units without turning a rejected weight into an accepted one. */
export function convertWeightDisplay(value, from, to) {
  if (!['kg', 'lbs'].includes(from) || !['kg', 'lbs'].includes(to)) throw new RangeError('Choose kg or lbs.');
  const original = String(value ?? '');
  if (original.trim() === '') return '';
  const input = Number(original);
  if (!Number.isFinite(input) || from === to) return original;
  const factor = 0.45359237;
  const weightKg = from === 'kg' ? input : input * factor;
  const converted = to === 'kg' ? weightKg : weightKg / factor;
  if (weightKg < 20 || weightKg > 300) {
    // Keep full precision outside the supported range: 661.4 lb must not turn
    // into a rounded, apparently valid 300 kg. Never clamp an invalid input.
    let result = converted;
    const convertedKg = to === 'kg' ? result : result * factor;
    if (Number.isFinite(result) && convertedKg >= 20 && convertedKg <= 300) {
      result += (weightKg < 20 ? -1 : 1) * Number.EPSILON * Math.max(1, Math.abs(result)) * 4;
    }
    return String(result);
  }
  let result = Math.round(converted * 10) / 10;
  const roundedKg = to === 'kg' ? result : result * factor;
  if (roundedKg < 20 || roundedKg > 300) {
    // Retain two decimals, rounded towards the valid interior only when the
    // original canonical weight was valid (300 kg -> 661.38 lb, not 661.4).
    result = (roundedKg > 300 ? Math.floor(converted * 100) : Math.ceil(converted * 100)) / 100;
  }
  return String(result);
}

export function calculateTarget({ weight, unit = 'kg', age, goal, meals = 4 } = {}) {
  const inputWeight = numeric(weight, 'Weight');
  const inputAge = numeric(age, 'Age');
  const inputMeals = numeric(meals, 'Meals');
  if (!['kg', 'lb', 'lbs'].includes(unit)) throw new RangeError('Choose kg or lb.');
  const weightKg = inputWeight * (unit === 'kg' ? 1 : 0.45359237);
  if (weightKg < 20 || weightKg > 300) throw new RangeError('Weight must be between 20 and 300 kg (44.1–661.4 lb).');
  if (!Number.isInteger(inputAge) || inputAge < 18 || inputAge > 100) throw new RangeError('This adult calculator supports ages 18–100.');
  if (typeof goal !== 'string' || !own(GOALS, goal)) throw new RangeError('Choose a valid goal.');
  if (![3, 4].includes(inputMeals)) throw new RangeError('Choose 3 or 4 eating occasions.');
  const choice = GOALS[goal];
  const target = Math.round(weightKg * choice.perKg);
  return {
    target, min: Math.round(weightKg * choice.minPerKg), max: Math.round(weightKg * choice.maxPerKg),
    perMeal: Math.round(target / inputMeals), perKg: choice.perKg, proteinCalories: target * 4,
    weightKg: round1(weightKg), goal, meals: inputMeals,
    assumptions: [
      'A starter estimate for generally healthy adults who exercise regularly, not a precise personal requirement.',
      'The ISSN describes 1.4–2.0 g/kg/day as sufficient for most exercising adults. Each goal chooses a starting point within that same range.',
      'Goal selections of 1.4, 1.6 and 1.8 g/kg/day are product choices, not separately validated goal-specific formulas.',
      'The general adult RDA is 0.8 g/kg/day; this training-focused estimate is not the baseline for someone who does not exercise.',
      'No sex multiplier or extra activity multiplier is applied. Age checks eligibility and does not diagnose individual needs.',
      'Protein calories are protein grams × 4. They are not your daily calorie needs, and this result does not prescribe a calorie deficit.',
      'Pregnancy, breastfeeding, medical conditions, prescribed diets, and very high or low body weights need individual advice.',
    ],
  };
}

const MEAL_TEMPLATES = {
  mixed: [
    { id: 'breakfast', label: 'Breakfast', items: [['yogurt', 200, 100, 300], ['oats', 50, 25, 80]] },
    { id: 'lunch', label: 'Lunch', items: [['chicken', 120, 60, 200], ['lentils', 80, 40, 150]] },
    { id: 'dinner', label: 'Dinner', items: [['tofu', 150, 75, 250], ['edamame', 80, 40, 150]] },
    { id: 'snack', label: 'Snack', items: [['cottage', 150, 75, 250]] },
  ],
  vegetarian: [
    { id: 'breakfast', label: 'Breakfast', items: [['yogurt', 200, 100, 300], ['oats', 50, 25, 80]] },
    { id: 'lunch', label: 'Lunch', items: [['tofu', 180, 90, 280], ['lentils', 100, 50, 180]] },
    { id: 'dinner', label: 'Dinner', items: [['chickpeas', 150, 75, 240], ['edamame', 100, 50, 180]] },
    { id: 'snack', label: 'Snack', items: [['cottage', 150, 75, 250]] },
  ],
};

export function buildMealExample(target, { diet = 'mixed', meals = 4 } = {}) {
  const grams = numeric(target, 'Protein target');
  const count = numeric(meals, 'Meals');
  if (grams <= 0 || grams > 600) throw new RangeError('Protein target must be greater than 0 and no more than 600 g.');
  if (![3, 4].includes(count)) throw new RangeError('Choose 3 or 4 eating occasions.');
  if (typeof diet !== 'string' || !own(MEAL_TEMPLATES, diet)) throw new RangeError('Choose mixed or vegetarian.');
  const templates = MEAL_TEMPLATES[diet].slice(0, count);
  const base = templates.reduce((sum, meal) => sum + meal.items.reduce((sub, [id, amount]) => sub + amount * FOODS.find(item => item.id === id).p100 / 100, 0), 0);
  const scale = Math.max(0.5, Math.min(1.8, grams / base));
  const result = templates.map(template => {
    const items = template.items.map(([foodId, standard, min, max]) => {
      const amount = Math.max(min, Math.min(max, Math.round(standard * scale / 5) * 5));
      return { foodId, amount, protein: round1(amount * FOODS.find(item => item.id === foodId).p100 / 100) };
    });
    return { id: template.id, label: template.label, items, protein: round1(items.reduce((sum, item) => sum + item.protein, 0)) };
  });
  const totalProtein = round1(result.reduce((sum, meal) => sum + meal.protein, 0));
  return {
    meals: result, totalProtein, diet,
    note: `Illustrative protein foods, about ${totalProtein} g in total. Portions are kept practical and may not equal your target. Add vegetables, fruit, carbohydrates and fats to make complete meals. Check labels, allergies and dietary needs. Vegetarian includes dairy; this is not a complete calorie or weight-loss plan.`,
  };
}

export function validateFoodEntry({ food: foodName, amount, p100, date = localDate() } = {}) {
  if (typeof foodName !== 'string') throw new TypeError('Enter a food name.');
  const name = foodName.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name.length > 120 || /[<>]/.test(name)) throw new RangeError('Food name must be 1–120 characters without HTML angle brackets.');
  const quantity = numeric(amount, 'Amount');
  const density = numeric(p100, 'Protein per 100');
  if (quantity < 0.1 || quantity > 2000) throw new RangeError('Amount must be between 0.1 and 2,000 g or ml.');
  if (density < 0 || density > 100) throw new RangeError('Protein per 100 must be between 0 and 100 g.');
  if (!validDateString(date)) throw new RangeError('Choose a real date in YYYY-MM-DD format.');
  return { food: name, amount: quantity, p100: density, protein: round1(quantity * density / 100), date };
}

export function readLegacyProfiles(storage) {
  const result = { profiles: [], error: null, warnings: [], skippedEntries: 0 };
  let raw;
  try { raw = storage.getItem('ptcalc_users_v1'); }
  catch { return { ...result, error: 'Browser storage is unavailable. Your old data has not been changed.' }; }
  if (!raw) return result;
  let source;
  try { source = JSON.parse(raw); }
  catch { return { ...result, error: 'Old tracker data could not be read. Your old data has not been changed.' }; }
  if (!source || typeof source !== 'object' || Array.isArray(source)) return { ...result, error: 'Old tracker data has an unrecognized format. Your old data has not been changed.' };
  for (const [name, profile] of Object.entries(source)) {
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) {
      result.warnings.push('One invalid old profile was skipped.');
      continue;
    }
    let profileGoal = 112;
    try {
      const candidate = numeric(profile.goal, 'Old goal');
      if (candidate <= 0 || candidate > 600) throw new RangeError();
      profileGoal = candidate;
    } catch { result.warnings.push(`An invalid old goal was replaced with a provisional 112 g goal. Review it before importing.`); }
    const entries = [];
    if (!Array.isArray(profile.entries)) result.warnings.push('An old profile had no readable entries array.');
    for (const entry of Array.isArray(profile.entries) ? profile.entries : []) {
      try {
        if (!entry || typeof entry !== 'object' || !validDateString(entry.date)) throw new TypeError();
        const valid = validateFoodEntry({ food: entry.food, amount: entry.amount, p100: entry.p100, date: entry.date });
        // Preserve the original rounded protein total when it is consistent with
        // the old calculator; never copy arbitrary objects, passwords or tokens.
        if (typeof entry.protein === 'number' && Number.isFinite(entry.protein) && entry.protein >= 0 && Math.abs(entry.protein - valid.protein) <= 0.51) valid.protein = entry.protein;
        if (typeof entry.ts === 'number' && Number.isFinite(entry.ts) && entry.ts > 0 && entry.ts < 8640000000000000) valid.ts = entry.ts;
        entries.push(valid);
      } catch { result.skippedEntries += 1; }
    }
    const safeName = name.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 120) || 'Old profile';
    result.profiles.push({ name: safeName, goal: profileGoal, entries });
  }
  if (result.skippedEntries) result.warnings.push(`${result.skippedEntries} invalid old food entr${result.skippedEntries === 1 ? 'y was' : 'ies were'} skipped. The original browser data is untouched.`);
  return result;
}

export function summarizeHistory(entries, goal, days = 7, today = new Date()) {
  const dailyGoal = numeric(goal, 'Daily goal');
  const count = numeric(days, 'History days');
  if (dailyGoal <= 0 || dailyGoal > 600) throw new RangeError('Daily goal must be greater than 0 and no more than 600 g.');
  if (!Number.isInteger(count) || count < 1 || count > 366) throw new RangeError('History days must be an integer from 1 to 366.');
  localDate(today); // Also validates the Date, without converting the local day to UTC.
  const byDay = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || !validDateString(entry.date) || typeof entry.protein !== 'number' || !Number.isFinite(entry.protein) || entry.protein < 0) continue;
    const current = byDay.get(entry.date) || { protein: 0, entries: 0 };
    current.protein += entry.protein;
    current.entries += 1;
    byDay.set(entry.date, current);
  }
  const history = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset, 12);
    const key = localDate(date);
    const record = byDay.get(key) || { protein: 0, entries: 0 };
    const protein = round1(record.protein);
    history.push({ date: key, protein, goal: dailyGoal, goalMet: protein >= dailyGoal, entries: record.entries });
  }
  const total = round1(history.reduce((sum, day) => sum + day.protein, 0));
  return {
    days: history, total, average: round1(total / count), daysMet: history.filter(day => day.goalMet).length,
    daysLogged: history.filter(day => day.entries > 0).length, goal: dailyGoal,
    note: `Average includes all ${count} calendar days; days without logged food count as zero. Goal comparisons use your current goal.`,
  };
}

export function makeDemoData(date = new Date()) {
  const today = localDate(date);
  const templates = [
    ['Greek yogurt (plain, nonfat)', 200, 10],
    ['Rolled oats (dry)', 50, 13],
    ['Chicken breast (cooked, skinless)', 120, 31],
  ];
  const entries = templates.map(([name, amount, p100], index) => ({ ...validateFoodEntry({ food: name, amount, p100, date: today }), id: `demo-today-${index}`, ts: date.getTime() + index }));
  for (let offset = 6; offset >= 1; offset -= 1) {
    if (offset === 3) continue; // A missing day intentionally illustrates calendar averages.
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate() - offset, 12);
    const protein = [0, 105, 118, 0, 94, 120, 108][offset];
    entries.push({ id: `demo-history-${offset}`, food: 'Example day of logged food', amount: 500, p100: protein / 5, protein, date: localDate(day), ts: day.getTime() });
  }
  return { goal: 112, entries, isDemo: true, name: 'Demo explorer' };
}
