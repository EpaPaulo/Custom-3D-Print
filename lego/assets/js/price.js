// What a plate costs to make and to send.
//
// Two separate questions, and they are answered from two different properties
// of the same object. Making it is priced from the slice — the material it
// actually extrudes and the hours it actually runs. Sending it is priced from
// the box it goes in, which for a printed plate is decided by its footprint,
// not its weight: a baseplate weighs a couple of hundred grams and is the size
// of a sheet of paper, and every carrier charges for the second of those.

import { slicePrint } from './slice.js';

/**
 * Shop rates. Material and machine time come from the slice, so these are
 * rates rather than guesses about any particular shape; the base fee covers
 * what does not scale with either — clearing the bed, checking the part,
 * packing it.
 *
 * Defaults for the open generator. A shop sets its own in the backend's
 * environment, and the backend's answer is what an order is priced at.
 */
export const RATES = {
  base: 4.5,
  perGram: 0.06,
  perHour: 1.2,
  currency: 'EUR',
};

/**
 * The parcel a plate travels in.
 *
 * `volumetricDivisor` is the carrier's, and it is what turns a box's size into
 * the weight it is billed at. Every carrier bills whichever is greater, the
 * real weight or that one, which for these products is nearly always the
 * second: a 40-stud plate prints at under 200 g and ships as 0.7 kg.
 */
export const PARCEL = {
  packagingGrams: 120,   // box, padding, label
  paddingMm: 25,         // added to the footprint, both directions
  minHeightMm: 30,       // a flat plate still needs a box with some depth to it
  volumetricDivisor: 5000,
};

/**
 * Where it can go, and what that costs.
 *
 * **These are placeholder rates.** They are the shape a carrier's price list
 * takes — brackets by billed weight, then a per-kilo rate above the last one —
 * filled in with plausible numbers so the generator quotes something sensible
 * out of the box. Replace them with your carrier's own before you sell
 * anything: see SHIPPING_ZONES in the backend's .env.example.
 */
export const ZONES = [
  {
    id: 'pickup',
    label: 'Levantamento — sem envio',
    tiers: [],
    perExtraKg: 0,
  },
  {
    id: 'pt',
    label: 'Portugal continental',
    tiers: [
      { upToKg: 0.5, price: 3.5 },
      { upToKg: 2, price: 4.9 },
      { upToKg: 5, price: 7.5 },
      { upToKg: 10, price: 10.9 },
    ],
    perExtraKg: 1.5,
  },
  {
    id: 'islands',
    label: 'Madeira e Açores',
    tiers: [
      { upToKg: 0.5, price: 6.5 },
      { upToKg: 2, price: 9.5 },
      { upToKg: 5, price: 15 },
      { upToKg: 10, price: 22 },
    ],
    perExtraKg: 2.5,
  },
  {
    id: 'eu',
    label: 'União Europeia',
    tiers: [
      { upToKg: 0.5, price: 9.5 },
      { upToKg: 2, price: 13.5 },
      { upToKg: 5, price: 19 },
      { upToKg: 10, price: 28 },
    ],
    perExtraKg: 3,
  },
  {
    id: 'world',
    label: 'Resto do mundo',
    tiers: [
      { upToKg: 0.5, price: 16 },
      { upToKg: 2, price: 26 },
      { upToKg: 5, price: 42 },
      { upToKg: 10, price: 65 },
    ],
    perExtraKg: 6,
  },
];

export const DEFAULT_ZONE = 'pt';
export const zoneById = (id, zones = ZONES) => zones.find((z) => z.id === id);

const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * The box, and the weight it will be billed at.
 *
 * `size` is the part's bounding box in millimetres and `grams` what it prints
 * at; everything else is the packaging.
 */
export function parcelFor(size, grams, parcel = {}) {
  const p = { ...PARCEL, ...parcel };
  const length = (size.x || 0) + p.paddingMm;
  const width = (size.y || 0) + p.paddingMm;
  const height = Math.max((size.z || 0) + p.paddingMm, p.minHeightMm);

  const actualKg = (grams + p.packagingGrams) / 1000;
  // Centimetres, which is the unit every carrier states the divisor in.
  const volumetricKg = ((length / 10) * (width / 10) * (height / 10)) / p.volumetricDivisor;

  return {
    lengthMm: round2(length),
    widthMm: round2(width),
    heightMm: round2(height),
    actualKg: round3(actualKg),
    volumetricKg: round3(volumetricKg),
    // What the carrier bills on, and which of the two decided it — worth
    // showing, because "it costs that because it is big, not because it is
    // heavy" is not obvious to anyone.
    billedKg: round3(Math.max(actualKg, volumetricKg)),
    billedBy: volumetricKg > actualKg ? 'size' : 'weight',
  };
}

/**
 * What sending that parcel costs.
 *
 * A zone with no brackets ships free, which is how collection in person is
 * expressed. Above the last bracket the per-kilo rate takes over, so an
 * oversized order is quoted rather than refused.
 */
export function shippingFor(size, grams, options = {}) {
  const zones = options.zones || ZONES;
  const zone = zoneById(options.zone, zones) || zoneById(DEFAULT_ZONE, zones) || zones[0];
  const parcel = parcelFor(size, grams, options.parcel);

  let price = 0;
  if (zone && zone.tiers && zone.tiers.length) {
    const last = zone.tiers[zone.tiers.length - 1];
    const tier = zone.tiers.find((t) => parcel.billedKg <= t.upToKg);
    price = tier
      ? tier.price
      : last.price + Math.ceil(parcel.billedKg - last.upToKg) * (zone.perExtraKg || 0);
  }

  return {
    zone: zone ? zone.id : null,
    label: zone ? zone.label : null,
    price: round2(price),
    parcel,
    free: false,
  };
}

/**
 * The whole price: what it costs to make, what it costs to send, and the sum.
 *
 * `options.shipping.flat` replaces the zone table with one number, for a shop
 * that charges the same to send anything and would rather not maintain a price
 * list. `options.shipping.freeAbove` waives the charge once the goods reach a
 * threshold; zero, the default, never waives it.
 */
export function priceOf(print, options = {}) {
  const rates = { ...RATES, ...options.rates };
  const material = print.grams * rates.perGram;
  const machine = print.hours * rates.perHour;
  const goods = rates.base + material + machine;

  const ship = { ...(options.shipping || {}) };
  const size = options.size || print.size || { x: 0, y: 0, z: 0 };

  let shipping;
  if (ship.enabled === false) {
    shipping = null;
  } else if (Number.isFinite(ship.flat)) {
    shipping = {
      zone: 'flat', label: ship.label || 'Envio', price: round2(ship.flat),
      parcel: parcelFor(size, print.grams, ship.parcel), free: false,
    };
  } else {
    shipping = shippingFor(size, print.grams, {
      zone: ship.zone, zones: ship.zones, parcel: ship.parcel,
    });
  }

  if (shipping && ship.freeAbove > 0 && goods >= ship.freeAbove) {
    shipping = { ...shipping, price: 0, free: true };
  }

  const delivered = goods + (shipping ? shipping.price : 0);

  return {
    currency: rates.currency,
    base: round2(rates.base),
    material: round2(material),
    machine: round2(machine),
    // What the plate costs, before it goes anywhere.
    goods: round2(goods),
    shipping,
    // What the customer pays.
    total: round2(delivered),
    grams: round2(print.grams),
    metres: round2(print.metres),
    hours: round2(print.hours),
    layers: print.layers,
    // How much of the solid the print actually is. A thin plate is nearly all
    // skin and comes out near 100%; a thick one is mostly air.
    fill: print.solidMm3 > 0 ? Math.round((print.volumeMm3 / print.solidMm3) * 100) : 100,
    profile: print.profile,
  };
}

/** Every zone priced at once, so a storefront can offer the choice. */
export function shippingOptions(print, options = {}) {
  const zones = (options.shipping && options.shipping.zones) || ZONES;
  const size = options.size || print.size || { x: 0, y: 0, z: 0 };
  const rates = { ...RATES, ...options.rates };
  const goods = rates.base + print.grams * rates.perGram + print.hours * rates.perHour;
  const freeAbove = (options.shipping && options.shipping.freeAbove) || 0;

  return zones.map((zone) => {
    const quoted = shippingFor(size, print.grams, {
      zone: zone.id, zones, parcel: options.shipping && options.shipping.parcel,
    });
    return freeAbove > 0 && goods >= freeAbove ? { ...quoted, price: 0, free: true } : quoted;
  });
}

/** Slice and price in one go, which is all either caller wants. */
export function quotePrint(positions, options = {}) {
  return priceOf(slicePrint(positions, options), options);
}
