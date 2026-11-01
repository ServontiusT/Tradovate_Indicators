// Vwave: London (03:00 CT), RTH (08:30 CT) and Overnight (17:00 CT) anchored
// VWAPs, three user-anchored VWAPs, and 1.0, 2.0 and 3.0 SD bands.
// Port of the VWAP part of the MotiveWave Vwave study v2.3 (VwapModule +
// SessionVwap + SessionClock). Entry signals and delta are not part of it.
const predef = require("./tools/predef");
const meta = require("./tools/meta");

// ── SessionClock: America/Chicago, US DST rule hard-coded ──────────────
function nthSundayUtc(y, month, n) {
    const first = new Date(Date.UTC(y, month, 1)).getUTCDay();
    return Date.UTC(y, month, 1 + ((7 - first) % 7) + (n - 1) * 7);
}
function ctOffsetMin(ms) {
    const y = new Date(ms).getUTCFullYear();
    const dstStart = nthSundayUtc(y, 2, 2) + 8 * 3600e3;   // 2nd Sun Mar, 02:00 CST
    const dstEnd   = nthSundayUtc(y, 10, 1) + 7 * 3600e3;  // 1st Sun Nov, 02:00 CDT
    return (ms >= dstStart && ms < dstEnd) ? -300 : -360;
}
// A time on the CT clock: its CT date (epoch day), minute of day and weekday (0 = Sunday).
function ctClock(ms) {
    const ctMin = Math.floor(ms / 60000) + ctOffsetMin(ms);
    const date = Math.floor(ctMin / 1440);
    return { date, minute: ctMin - date * 1440, dow: (date + 4) % 7 };
}
const MINUTE = 60000;
const LONDON_OPEN = 3 * 60, RTH_OPEN = 8 * 60 + 30, GLOBEX_OPEN = 17 * 60;   // CT minutes of day

// ── Daily settlement (CME, CT clock) ───────────────────────────────────
// The settlement VWAP runs from one daily settlement to the next. The time
// is picked from the chart's symbol, or set by hand with "Settlement Market".
const SETTLE_MARKETS = {
    auto:   "Auto (from symbol)",
    equity: "Equity index / crypto (15:00)",
    rates:  "Treasuries / FX (14:00)",
    energy: "Energy (13:30)",
    grains: "Grains (13:15)",
    gold:   "Gold (12:30)",
    custom: "Custom time",
};
const SETTLE_MINUTE = { equity: 15 * 60, rates: 14 * 60, energy: 13 * 60 + 30, grains: 13 * 60 + 15, gold: 12 * 60 + 30 };
const DEFAULT_SETTLE = SETTLE_MINUTE.equity;
// Product root -> settlement minute of day (CT).
const ROOT_SETTLE = {};
const addRoots = (min, roots) => roots.forEach(r => { ROOT_SETTLE[r] = min; });
addRoots(SETTLE_MINUTE.equity, ["ES", "MES", "NQ", "MNQ", "YM", "MYM", "RTY", "M2K", "EMD", "NKD",
                                "BTC", "MBT", "ETH", "MET"]);
addRoots(SETTLE_MINUTE.rates,  ["ZT", "ZF", "ZN", "TN", "ZB", "UB", "TWE", "10Y", "2YY", "5YY", "30Y",
                                "6A", "6B", "6C", "6E", "6J", "6M", "6N", "6S", "M6A", "M6B", "M6E", "E7", "J7"]);
addRoots(SETTLE_MINUTE.energy, ["CL", "MCL", "QM", "NG", "QG", "MNG", "RB", "HO", "BZ"]);
addRoots(SETTLE_MINUTE.grains, ["ZC", "ZS", "ZW", "ZM", "ZL", "ZO", "KE", "XC", "XK", "XW"]);
addRoots(SETTLE_MINUTE.gold,   ["GC", "MGC", "QO"]);
addRoots(12 * 60 + 25,         ["SI", "SIL", "QI"]);    // silver
addRoots(13 * 60,              ["HG", "MHG", "QC"]);    // copper

// "ESZ6" / "MESZ2026" / "@ES" -> "ES" / "MES" / "ES".
function rootOf(symbol) {
    const s = String(symbol).trim().toUpperCase().replace(/^[@/]/, "");
    const m = /^([A-Z0-9]+?)(?:[FGHJKMNQUVXZ]\d{1,4})?$/.exec(s);
    return m ? m[1] : "";
}
// The chart's symbol, from whichever field Tradovate fills in; "" if none.
function symbolOf(ci) {
    if (!ci) return "";
    const c = [ci.symbol, ci.name, ci.contractName, ci.productName,
               ci.contract && ci.contract.name, ci.product && ci.product.name];
    return c.find(x => typeof x === "string" && x) || "";
}
// "HH:MM" to minute of day; NaN if not a time.
function parseHm(text) {
    const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(text || "");
    return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : NaN;
}
function settleMinute(props, ci) {
    const market = props.setMarket;
    if (market in SETTLE_MINUTE) return SETTLE_MINUTE[market];
    if (market === "custom") {
        const t = parseHm(props.setCustom);
        return isNaN(t) ? DEFAULT_SETTLE : t;
    }
    const root = rootOf(symbolOf(ci));
    return root in ROOT_SETTLE ? ROOT_SETTLE[root] : DEFAULT_SETTLE;
}

// "YYYY-MM-DD HH:MM" in CT to epoch ms; 0 if blank or not a date.
function parseCt(text) {
    const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2}))?\s*$/.exec(text || "");
    if (!m) return 0;
    const local = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
    let ms = local + 360 * MINUTE;                         // first guess: CST
    ms = local - ctOffsetMin(ms) * MINUTE;
    return local - ctOffsetMin(ms) * MINUTE;
}

// ── VwapModule ─────────────────────────────────────────────────────────
// SD multipliers are locked by design.
const BAND_PAIRS = { none: 0, one: 1, two: 2, three: 3 };
const BAND_CHOICES = { none: "0 Bands", one: "1 SD Bands", two: "2 SD Bands", three: "3 SD Bands" };
const LINES = [
    { suffix: "Vwap",   label: "VWAP",  pair: 0, mult:  0, width: 2, lineStyle: 1 },
    { suffix: "Upper1", label: "+1 SD", pair: 1, mult: +1, width: 1, lineStyle: 2 },   // dashed
    { suffix: "Lower1", label: "-1 SD", pair: 1, mult: -1, width: 1, lineStyle: 2 },
    { suffix: "Upper2", label: "+2 SD", pair: 2, mult: +2, width: 1, lineStyle: 3 },   // dotted
    { suffix: "Lower2", label: "-2 SD", pair: 2, mult: -2, width: 1, lineStyle: 3 },
    { suffix: "Upper3", label: "+3 SD", pair: 3, mult: +3, width: 1, lineStyle: 4 },   // dash-dot
    { suffix: "Lower3", label: "-3 SD", pair: 3, mult: -3, width: 1, lineStyle: 4 },
];
// Declaration order is drawing order: RTH last, so it sits on top. A slot
// (open: null) is anchored at the time in its "Time" param. The settlement
// anchor (settle: true) gets its open from settleMinute().
const ANCHORS = [
    { prefix: "on",  group: "Overnight (ON) VWAP", tag: "ON",      open: GLOBEX_OPEN, color: "#FFFFFF", opensSunday: true,  bands: "none" },
    { prefix: "set", group: "Settlement VWAP",     tag: "Settle",  open: 0, settle: true, color: "#66BB6A", opensSunday: false, bands: "none" },
    { prefix: "ldn", group: "London VWAP",         tag: "London",  open: LONDON_OPEN, color: "#FFB74D", opensSunday: false, bands: "none" },
    { prefix: "av1", group: "Anchored VWAP 1",     tag: "AVWAP 1", open: null,        color: "#E040FB", opensSunday: false, bands: "none" },
    { prefix: "av2", group: "Anchored VWAP 2",     tag: "AVWAP 2", open: null,        color: "#26C6DA", opensSunday: false, bands: "none" },
    { prefix: "av3", group: "Anchored VWAP 3",     tag: "AVWAP 3", open: null,        color: "#FF7043", opensSunday: false, bands: "none" },
    { prefix: "rth", group: "RTH VWAP",            tag: "RTH",     open: RTH_OPEN,    color: "#2196F3", opensSunday: false, bands: "one" },
];
// The order the params are listed in.
const SETTINGS_ORDER = ["ldn", "on", "rth", "set", "av1", "av2", "av3"].map(p => ANCHORS.find(a => a.prefix === p));

const isSlot = a => a.open === null;

// Sunday - Thursday for the Overnight VWAP, Monday - Friday for the others.
function anchorsOn(a, dow) {
    return a.opensSunday ? dow !== 5 && dow !== 6 : dow !== 6 && dow !== 0;
}
// The most recent daily anchor at or before the clock time, as CT minutes since the epoch.
function anchorOf(a, open, clock) {
    let date = clock.date;
    if (open > clock.minute) date -= 1;
    while (!anchorsOn(a, (date + 4) % 7)) date -= 1;
    return date * 1440 + open;
}

function sdOf(s) {
    const mid = s.pv / s.v;
    return Math.sqrt(Math.max(0, s.p2v / s.v - mid * mid));
}

// The bar's trades summed from its volume profile; null if it has none.
function profileSums(d) {
    const profile = typeof d.profile === "function" ? d.profile() : null;
    if (!profile || !profile.length) return null;
    let v = 0, pv = 0, p2v = 0;
    for (const lv of profile) {
        const vol = lv.vol || 0;
        v += vol; pv += lv.price * vol; p2v += lv.price * lv.price * vol;
    }
    return v > 0 ? { v, pv, p2v } : null;
}

// Shared with SystemOne. `hideable` adds the Show VWAP / Show SD Bands switches.
function vwapModule(hideable) {
    let sums = {};                      // prefix -> per-bar running sums (replaces series.setDouble)
    const parsed = {};                  // slot anchor text -> epoch ms
    const slotTime = text => (text in parsed) ? parsed[text] : (parsed[text] = parseCt(text));
    return {
        name: "VWAP",
        init() { sums = {}; ANCHORS.forEach(a => { sums[a.prefix] = []; }); },

        // The RTH VWAP's sums at bar i (replaces VwapModule.rthVwap()).
        rthAt(i) { return sums.rth[i]; },

        // endMs: when the bar ends (see barEnd), or NaN if not known.
        // contractInfo (optional): the calculator's contractInfo, used to
        // pick the settlement time.
        map(d, i, props, endMs, contractInfo) {
            const out = {};
            const start = d.timestamp().getTime();
            const settleOpen = settleMinute(props, contractInfo);

            // Trades: the bar's volume profile, and the bar belongs to the
            // period its last moment is in. Bar HLC3 (or a bar with no
            // profile): one point at the typical price, in the period the
            // bar opens in.
            const bar = props.vwapSource === "hlc3" ? null : profileSums(d);
            const at = bar && endMs > start ? Math.max(start, endMs - 1) : start;
            const clock = ctClock(at);
            let added = bar;
            if (!added) {
                const tp = (d.high() + d.low() + d.close()) / 3, vol = d.volume();
                added = { v: vol, pv: tp * vol, p2v: tp * tp * vol };
            }

            const showVwap  = !hideable || props.showVwap !== false;
            const showBands = !hideable || props.showBands !== false;

            for (const a of ANCHORS) {
                const series = sums[a.prefix];
                const prev = series[i - 1];
                let anchor;
                if (!isSlot(a)) anchor = anchorOf(a, a.settle ? settleOpen : a.open, clock);
                else {
                    const t = slotTime(props[a.prefix + "Time"]);
                    anchor = t > 0 && at >= t ? t : null;          // null: before the anchor, or none
                }
                if (anchor === null) { series[i] = { anchor: null }; continue; }

                const continues = prev !== undefined && prev.anchor === anchor;
                const s = continues
                    ? { anchor, v: prev.v, pv: prev.pv, p2v: prev.p2v }
                    : { anchor, v: 0, pv: 0, p2v: 0 };
                s.v += added.v; s.pv += added.pv; s.p2v += added.p2v;
                series[i] = s;  // the forming bar overwrites its own slot each tick

                // The bar that starts a new period plots nothing, so the line
                // breaks there instead of joining the old VWAP to the new one.
                const reset = prev !== undefined && prev.anchor !== null && !continues;
                const shownKey = props[a.prefix + "Show"];
                const shown = shownKey === undefined ? !isSlot(a) : shownKey !== false;
                if (reset || !shown || !(s.v > 0)) continue;

                const bands = props[a.prefix + "Bands"];
                const pairs = BAND_PAIRS[bands in BAND_PAIRS ? bands : a.bands];
                const mid = s.pv / s.v, sd = sdOf(s);
                for (const line of LINES) {
                    const on = line.pair === 0 ? showVwap : showBands && line.pair <= pairs;
                    if (on) out[a.prefix + line.suffix] = mid + line.mult * sd;
                }
            }
            return out;
        },
    };
}

// ── The indicator ──────────────────────────────────────────────────────
class vwave {
    init() {
        this.vwap = vwapModule(false);
        this.vwap.init();
    }

    map(d, i, history) {
        try {
            return this.vwap.map(d, i, this.props, barEnd(this, history, i), this.contractInfo);
        } catch (e) {
            return {};                  // skip this bar
        }
    }
}

// End time of bar j (replaces DataSeries.getEndTime): open + bar length on
// minute and daily charts, otherwise the next bar's open (NaN on the last bar).
function barEnd(calc, history, j) {
    const start = history.get(j).timestamp().getTime();
    const cd = calc.chartDescription;
    if (cd && cd.underlyingType === "MinuteBar" && cd.elementSizeUnit === "UnderlyingUnits")
        return start + cd.elementSize * MINUTE;
    if (cd && cd.underlyingType === "DailyBar" && cd.elementSizeUnit === "UnderlyingUnits")
        return start + cd.elementSize * 1440 * MINUTE;
    return j + 1 < history.size() ? history.get(j + 1).timestamp().getTime() : NaN;
}

// ── Params, plots and styles ───────────────────────────────────────────
const params = {
    vwapSource: predef.paramSpecs.enum({ trades: "Trades (volume profile)", hlc3: "Bar HLC3" }, "trades"),
};
for (const a of SETTINGS_ORDER) {
    params[a.prefix + "Show"] = predef.paramSpecs.bool(!isSlot(a));
    if (isSlot(a)) params[a.prefix + "Time"] = { type: "text", def: "" };   // "YYYY-MM-DD HH:MM" CT
    if (a.settle) {
        params.setMarket = predef.paramSpecs.enum(SETTLE_MARKETS, "auto");
        params.setCustom = { type: "text", def: "15:00" };                  // "HH:MM" CT, for Custom time
    }
    params[a.prefix + "Bands"] = predef.paramSpecs.enum(BAND_CHOICES, a.bands);
}

const plots = {}, styles = {};
for (const a of ANCHORS) {
    for (const line of LINES) {
        const key = a.prefix + line.suffix;
        plots[key] = { title: a.tag + " " + line.label };
        styles[key] = predef.styles.plot({ color: a.color, lineWidth: line.width, lineStyle: line.lineStyle });
    }
}

module.exports = {
    name: "Vwave",
    description: "S1:Multi Session VWAP",
    calculator: vwave,
    inputType: meta.InputType.BARS,
    areaChoice: meta.AreaChoice.OVERLAY,
    requirements: { volumeProfiles: true },
    tags: ["SystemOne"],
    params,
    plots,
    schemeStyles: { dark: styles },
};
