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

/**
 * How much of a layer's area is usable once flat things that are not the same
 * shape have to sit side by side. Nothing tessellates perfectly, and a packer
 * that assumed it did would under-quote every mixed order.
 */
export const PACKING = {
  efficiency: 0.8,
};

const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;

/**
 * The box a set of plates goes in, and the weight it will be billed at.
 *
 * `units` are the individual plates — one entry per plate, not per line, so a
 * quantity of three appears three times. They are packed the way someone
 * packing them would: flat, largest first, smaller ones laid beside a bigger
 * one where there is room, and a new layer started when there is not. The
 * box's footprint is the largest thing in it and its depth is the layers
 * stacked up.
 *
 * The area rule is an approximation, and deliberately a conservative one: two
 * plates whose areas fit in a layer might still not fit side by side, so
 * `efficiency` holds back a fifth of it. Over-quoting a box by a layer costs a
 * little; under-quoting one costs the difference on every order.
 */
export function packParcel(units, parcel = {}, packing = {}) {
  const p = { ...PARCEL, ...parcel };
  const k = { ...PACKING, ...packing };

  let footprintX = 0;
  let footprintY = 0;
  let grams = 0;
  for (const unit of units) {
    footprintX = Math.max(footprintX, (unit.size && unit.size.x) || 0);
    footprintY = Math.max(footprintY, (unit.size && unit.size.y) || 0);
    grams += unit.grams || 0;
  }

  // Thickest first: a layer's depth is set by the first thing in it, so filling
  // it with thinner plates afterwards costs nothing.
  const order = units.slice().sort((a, b) => ((b.size && b.size.z) || 0) - ((a.size && a.size.z) || 0));
  const usable = footprintX * footprintY * k.efficiency;

  const layers = [];
  for (const unit of order) {
    const area = ((unit.size && unit.size.x) || 0) * ((unit.size && unit.size.y) || 0);
    const depth = (unit.size && unit.size.z) || 0;
    // The largest plate never fits a layer alongside anything, since a layer
    // holds only `efficiency` of its own footprint. It gets one to itself.
    let layer = layers.find((l) => l.used + area <= usable);
    if (!layer) {
      layer = { used: 0, depth };
      layers.push(layer);
    }
    layer.used += area;
    layer.depth = Math.max(layer.depth, depth);
  }

  const stacked = layers.reduce((sum, l) => sum + l.depth, 0);
  const length = footprintX + p.paddingMm;
  const width = footprintY + p.paddingMm;
  const height = Math.max(stacked + p.paddingMm, p.minHeightMm);

  const actualKg = (grams + p.packagingGrams) / 1000;
  // Centimetres, which is the unit every carrier states the divisor in.
  const volumetricKg = ((length / 10) * (width / 10) * (height / 10)) / p.volumetricDivisor;

  return {
    lengthMm: round2(length),
    widthMm: round2(width),
    heightMm: round2(height),
    layers: layers.length,
    items: units.length,
    actualKg: round3(actualKg),
    volumetricKg: round3(volumetricKg),
    // What the carrier bills on, and which of the two decided it — worth
    // showing, because "it costs that because it is big, not because it is
    // heavy" is not obvious to anyone.
    billedKg: round3(Math.max(actualKg, volumetricKg)),
    billedBy: volumetricKg > actualKg ? 'size' : 'weight',
  };
}

/** The box for a single plate. */
export function parcelFor(size, grams, parcel = {}) {
  return packParcel([{ size, grams }], parcel);
}

/**
 * What sending a parcel costs.
 *
 * A zone with no brackets ships free, which is how collection in person is
 * expressed. Above the last bracket the per-kilo rate takes over, so an
 * oversized order is quoted rather than refused.
 */
export function priceParcel(parcel, options = {}) {
  const zones = options.zones || ZONES;
  const zone = zoneById(options.zone, zones) || zoneById(DEFAULT_ZONE, zones) || zones[0];

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

/** What sending one plate costs. */
export function shippingFor(size, grams, options = {}) {
  return priceParcel(parcelFor(size, grams, options.parcel), options);
}

/** Every zone priced for one parcel, so a storefront can offer the choice. */
export function zoneOptions(parcel, options = {}) {
  const zones = options.zones || ZONES;
  const freeAbove = options.freeAbove || 0;
  const goods = options.goods || 0;
  return zones.map((zone) => {
    const quoted = priceParcel(parcel, { zone: zone.id, zones });
    return freeAbove > 0 && goods >= freeAbove ? { ...quoted, price: 0, free: true } : quoted;
  });
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

/** Every zone priced for one plate, so a storefront can offer the choice. */
export function shippingOptions(print, options = {}) {
  const ship = options.shipping || {};
  const size = options.size || print.size || { x: 0, y: 0, z: 0 };
  const rates = { ...RATES, ...options.rates };
  const goods = rates.base + print.grams * rates.perGram + print.hours * rates.perHour;

  return zoneOptions(parcelFor(size, print.grams, ship.parcel), {
    zones: ship.zones, freeAbove: ship.freeAbove, goods,
  });
}

/**
 * One order's worth of plates, in one box.
 *
 * `lines` are what was ordered — each carrying the print estimate for one
 * plate and how many of them — and the shipping is quoted for the single
 * parcel they all travel in. Quoting them separately and adding it up is what
 * this exists to avoid: three plates in one box cost one delivery, not three.
 *
 * The base fee is charged per plate, not per order: each one is its own print,
 * with its own bed to clear and part to check. Only the delivery is shared.
 */
export function priceBasket(lines, options = {}) {
  const rates = { ...RATES, ...options.rates };
  const ship = { ...(options.shipping || {}) };

  const units = [];
  let goods = 0;
  const priced = lines.map((line) => {
    const print = line.print;
    const quantity = Math.max(1, Math.round(line.quantity || 1));
    const material = print.grams * rates.perGram;
    const machine = print.hours * rates.perHour;
    // Rounded here, before the quantity multiplies it. An invoice has to be
    // arithmetic a customer can redo: unit price times quantity, and the lines
    // adding up to the total. Rounding after multiplying breaks both by a cent.
    const unit = round2(rates.base + material + machine);
    const lineTotal = round2(unit * quantity);

    for (let i = 0; i < quantity; i++) units.push({ size: print.size, grams: print.grams });
    goods += lineTotal;

    return {
      ...(line.designId ? { designId: line.designId } : {}),
      spec: line.spec,
      quantity,
      size: print.size,
      unit: {
        base: round2(rates.base),
        material: round2(material),
        machine: round2(machine),
        total: unit,
        grams: round2(print.grams),
        hours: round2(print.hours),
        layers: print.layers,
      },
      lineTotal,
    };
  });

  const parcel = packParcel(units, ship.parcel, ship.packing);

  let shipping = null;
  if (ship.enabled !== false) {
    shipping = Number.isFinite(ship.flat)
      ? { zone: 'flat', label: ship.label || 'Envio', price: round2(ship.flat), parcel, free: false }
      : priceParcel(parcel, { zone: ship.zone, zones: ship.zones });
    if (ship.freeAbove > 0 && goods >= ship.freeAbove) {
      shipping = { ...shipping, price: 0, free: true };
    }
  }

  return {
    currency: rates.currency,
    items: priced,
    units: units.length,
    grams: round2(units.reduce((sum, u) => sum + u.grams, 0)),
    hours: round2(lines.reduce((sum, l) => sum + l.print.hours * Math.max(1, Math.round(l.quantity || 1)), 0)),
    goods: round2(goods),
    parcel,
    shipping,
    total: round2(goods + (shipping ? shipping.price : 0)),
  };
}

/** Slice and price in one go, which is all either caller wants. */
export function quotePrint(positions, options = {}) {
  return priceOf(slicePrint(positions, options), options);
}
