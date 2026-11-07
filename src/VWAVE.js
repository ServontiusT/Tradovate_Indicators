// Vwave: London (03:00 CT), RTH (08:30 CT), Overnight (17:00 CT) and Daily
// Settlement anchored VWAPs, three user-anchored VWAPs, and 1.0, 2.0 and 3.0
// SD bands.
// Port of the VWAP part of the MotiveWave Vwave study v2.3 (VwapModule +
// SessionVwap + SessionClock). Entry signals and delta are not part of it.
//
// User anchors (AVWAP 1-3): the settings dialog does not show text params, so
// each slot is set with numbers, like the Anchored VWAP indicator:
//   Mode   Off | Date/time | Today | Yesterday | Bar index
//   Date   YYYYMMDD, e.g. 20261030            (Date/time mode)
//   Time   HHMM in CT, e.g. 930 = 09:30       (Date/time, Today, Yesterday)
//   Index  bar index, may be negative         (Bar index mode)
// A Bar index anchor prints its bar's CT date and time on the chart, ready to
// type into Date and Time so the anchor survives history and timeframe changes.
//
// Settlement VWAP: restarts each weekday at the product's CME daily settlement
// time. "Auto" reads the product from the contract symbol; pick a product
// group or a custom HHMM if it guesses wrong. Holiday early settlements are
// not modeled.
const predef = require("./tools/predef");
const meta = require("./tools/meta");
const { px, du, op } = require("./tools/graphics");

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

// A CT wall-clock time (as if it were UTC ms) to epoch ms.
function ctWallToMs(local) {
    let ms = local + 360 * MINUTE;                         // first guess: CST
    ms = local - ctOffsetMin(ms) * MINUTE;
    return local - ctOffsetMin(ms) * MINUTE;
}
// "YYYY-MM-DD HH:MM" in CT to epoch ms; 0 if blank or not a date. Kept for
// callers (e.g. SystemOne) that still pass the old text anchors.
function parseCt(text) {
    const m = /^\s*(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]+(\d{1,2}):(\d{2}))?\s*$/.exec(text || "");
    if (!m) return 0;
    return ctWallToMs(Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)));
}

// HHMM number -> minute of day, or null.
function hhmmToMinute(hhmm) {
    const n = Number(hhmm);
    if (!isFinite(n) || n < 0 || n > 2359) return null;
    const h = Math.floor(Math.floor(n) / 100), m = Math.floor(n) % 100;
    return h > 23 || m > 59 ? null : h * 60 + m;
}
// YYYYMMDD number -> CT epoch day, or null.
function yyyymmddToDay(num) {
    const n = Math.floor(Number(num));
    if (!isFinite(n) || n < 10000101 || n > 99991231) return null;
    const y = Math.floor(n / 10000), mo = Math.floor(n / 100) % 100, d = n % 100;
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    return Date.UTC(y, mo - 1, d) / 86400000;
}
// Epoch ms -> the CT numbers the Date and Time fields take.
function ctFields(ms) {
    const c = ctClock(ms), day = new Date(c.date * 86400000);
    return {
        date: day.getUTCFullYear() * 10000 + (day.getUTCMonth() + 1) * 100 + day.getUTCDate(),
        time: Math.floor(c.minute / 60) * 100 + c.minute % 60,
    };
}

// ── Daily settlement times (CT minute of day), CME ─────────────────────
const SETTLE_GROUPS = {
    equity:    { label: "Equity index / crypto 15:00", minute: 15 * 60,      roots: ["ES", "MES", "NQ", "MNQ", "YM", "MYM", "RTY", "M2K", "EMD", "BTC", "MBT", "ETH", "MET"] },
    energy:    { label: "Energy 13:30",                minute: 13 * 60 + 30, roots: ["CL", "MCL", "QM", "NG", "QG", "MNG", "RB", "HO", "BZ"] },
    gold:      { label: "Gold 12:30",                  minute: 12 * 60 + 30, roots: ["GC", "MGC", "1OZ"] },
    silver:    { label: "Silver 12:25",                minute: 12 * 60 + 25, roots: ["SI", "SIL", "SIC"] },
    copper:    { label: "Copper 12:00",                minute: 12 * 60,      roots: ["HG", "MHG"] },
    platinum:  { label: "Platinum 12:05",              minute: 12 * 60 + 5,  roots: ["PL"] },
    ratesFx:   { label: "Treasuries / FX 14:00",       minute: 14 * 60,      roots: ["ZN", "ZB", "ZF", "ZT", "UB", "TN", "TWE", "6E", "6J", "6B", "6A", "6C", "6S", "6N", "6M", "M6E", "M6A", "M6B", "E7", "J7"] },
    grains:    { label: "Grains 13:15",                minute: 13 * 60 + 15, roots: ["ZC", "ZS", "ZW", "ZM", "ZL", "ZO", "KE", "XC", "XW", "XK"] },
    livestock: { label: "Livestock 13:05",             minute: 13 * 60 + 5,  roots: ["LE", "HE", "GF"] },
};
const SETTLE_DEFAULT = SETTLE_GROUPS.equity.minute;
const SETTLE_CHOICES = { auto: "Auto (from symbol)" };
for (const k in SETTLE_GROUPS) SETTLE_CHOICES[k] = SETTLE_GROUPS[k].label;
SETTLE_CHOICES.custom = "Custom (Settle Time)";

// Root of a futures symbol: "MNQZ6" -> "MNQ", "6EH27" -> "6E".
function symbolRoot(sym) {
    const s = String(sym || "").toUpperCase().replace(/^@/, "").trim();
    const m = /^([A-Z0-9]+?)[FGHJKMNQUVXZ]\d{1,2}$/.exec(s);
    return m ? m[1] : s;
}
function symbolOf(ci, cd) {
    const cands = [];
    if (ci) cands.push(ci.symbol, ci.name, ci.contractName, ci.productName,
        ci.product && (ci.product.name || ci.product), ci.contract && (ci.contract.name || ci.contract));
    if (cd) cands.push(cd.symbol, cd.contractSymbol);
    for (const c of cands) if (typeof c === "string" && c) return c;
    return "";
}
function settleMinute(props, ci, cd) {
    const pick = props.stlProduct;
    if (pick === "custom") {
        const m = hhmmToMinute(props.stlTime);
        return m === null ? SETTLE_DEFAULT : m;
    }
    if (pick in SETTLE_GROUPS) return SETTLE_GROUPS[pick].minute;
    const root = symbolRoot(symbolOf(ci, cd));
    for (const k in SETTLE_GROUPS) if (SETTLE_GROUPS[k].roots.indexOf(root) >= 0) return SETTLE_GROUPS[k].minute;
    return SETTLE_DEFAULT;
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
// (open: null) is anchored by its Mode/Date/Time/Index params. The
// settlement anchor (open: "settle") takes its time from settleMinute().
const ANCHORS = [
    { prefix: "on",  group: "Overnight (ON) VWAP", tag: "ON",      open: GLOBEX_OPEN, color: "#FFFFFF", opensSunday: true,  bands: "none" },
    { prefix: "ldn", group: "London VWAP",         tag: "London",  open: LONDON_OPEN, color: "#FFB74D", opensSunday: false, bands: "none" },
    { prefix: "stl", group: "Settlement VWAP",     tag: "Settle",  open: "settle",    color: "#66BB6A", opensSunday: false, bands: "none" },
    { prefix: "av1", group: "Anchored VWAP 1",     tag: "AVWAP 1", open: null,        color: "#E040FB", opensSunday: false, bands: "none" },
    { prefix: "av2", group: "Anchored VWAP 2",     tag: "AVWAP 2", open: null,        color: "#26C6DA", opensSunday: false, bands: "none" },
    { prefix: "av3", group: "Anchored VWAP 3",     tag: "AVWAP 3", open: null,        color: "#FF7043", opensSunday: false, bands: "none" },
    { prefix: "rth", group: "RTH VWAP",            tag: "RTH",     open: RTH_OPEN,    color: "#2196F3", opensSunday: false, bands: "one" },
];
// The order the params are listed in.
const SETTINGS_ORDER = ["ldn", "on", "rth", "stl", "av1", "av2", "av3"].map(p => ANCHORS.find(a => a.prefix === p));

const isSlot = a => a.open === null;
const SLOT_MODES = { off: "Off", datetime: "Date/time", today: "Today", yesterday: "Yesterday", barIndex: "Bar index" };

// Sunday - Thursday for the Overnight VWAP, Monday - Friday for the others.
function anchorsOn(a, dow) {
    return a.opensSunday ? dow !== 5 && dow !== 6 : dow !== 6 && dow !== 0;
}
// The most recent daily anchor at or before the clock time, as CT minutes since the epoch.
function anchorOf(a, clock, open) {
    let date = clock.date;
    if (open > clock.minute) date -= 1;
    while (!anchorsOn(a, (date + 4) % 7)) date -= 1;
    return date * 1440 + open;
}

// A slot's anchor from its params: { time } (epoch ms), { index }, or null (off / invalid).
function slotSpec(props, prefix) {
    const mode = props[prefix + "Mode"], time = props[prefix + "Time"];
    if (mode === undefined && typeof time === "string") {          // old text anchor
        const t = parseCt(time);
        return t > 0 ? { time: t } : null;
    }
    if (mode === "barIndex") {
        const idx = Number(props[prefix + "Index"]);
        return isFinite(idx) ? { index: Math.round(idx) } : null;
    }
    if (mode !== "datetime" && mode !== "today" && mode !== "yesterday") return null;
    const minute = hhmmToMinute(time);
    if (minute === null) return null;
    let day;
    if (mode === "datetime") day = yyyymmddToDay(props[prefix + "Date"]);
    else day = ctClock(Date.now()).date - (mode === "yesterday" ? 1 : 0);
    if (day === null) return null;
    return { time: ctWallToMs(day * 86400000 + minute * MINUTE) };
}

function barIndexOf(d, fallback) {
    if (d && typeof d.index === "function") {
        const v = d.index();
        if (typeof v === "number" && isFinite(v)) return v;
    }
    return fallback;
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
    const specs = {};                   // slot param key -> slotSpec
    const specOf = (props, prefix) => {
        const key = [prefix, props[prefix + "Mode"], props[prefix + "Date"], props[prefix + "Time"], props[prefix + "Index"]].join("|");
        return (key in specs) ? specs[key] : (specs[key] = slotSpec(props, prefix));
    };
    return {
        name: "VWAP",
        init() { sums = {}; ANCHORS.forEach(a => { sums[a.prefix] = []; }); },

        // The RTH VWAP's sums at bar i (replaces VwapModule.rthVwap()).
        rthAt(i) { return sums.rth[i]; },

        // endMs: when the bar ends (see barEnd), or NaN if not known.
        // ci / cd: contractInfo and chartDescription, for the settlement time.
        map(d, i, props, endMs, ci, cd) {
            const out = {};
            const labels = [];
            const start = d.timestamp().getTime();
            const barIndex = barIndexOf(d, i);

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
                let anchor, spec = null;
                if (isSlot(a)) {
                    spec = specOf(props, a.prefix);
                    if (spec === null) anchor = null;
                    else if ("index" in spec) anchor = barIndex >= spec.index ? "#" + spec.index : null;
                    else anchor = at >= spec.time ? spec.time : null;    // null: before the anchor
                } else {
                    const open = a.open === "settle" ? settleMinute(props, ci, cd) : a.open;
                    anchor = anchorOf(a, clock, open);
                }
                if (anchor === null) { series[i] = { anchor: null }; continue; }

                const continues = prev !== undefined && prev.anchor === anchor;
                const s = continues
                    ? { anchor, v: prev.v, pv: prev.pv, p2v: prev.p2v }
                    : { anchor, v: 0, pv: 0, p2v: 0 };
                s.v += added.v; s.pv += added.pv; s.p2v += added.p2v;
                series[i] = s;  // the forming bar overwrites its own slot each tick

                // A Bar index anchor labels its first bar with the Date/Time to type in.
                if (spec && "index" in spec && !continues) {
                    const f = ctFields(start);
                    labels.push({ key: a.prefix, color: a.color,
                        text: "▲ " + a.tag + ": date " + f.date + " time " + f.time + " (#" + barIndex + ")" });
                }

                // The bar that starts a new period plots nothing, so the line
                // breaks there instead of joining the old VWAP to the new one.
                const reset = prev !== undefined && prev.anchor !== null && !continues;
                const shown = props[a.prefix + "Show"] !== false;   // slots: Mode Off already returned
                if (reset || !shown || !(s.v > 0)) continue;

                const bands = props[a.prefix + "Bands"];
                const pairs = BAND_PAIRS[bands in BAND_PAIRS ? bands : a.bands];
                const mid = s.pv / s.v, sd = sdOf(s);
                for (const line of LINES) {
                    const on = line.pair === 0 ? showVwap : showBands && line.pair <= pairs;
                    if (on) out[a.prefix + line.suffix] = mid + line.mult * sd;
                }
            }
            if (labels.length) {
                out.graphics = {
                    items: labels.map((l, n) => ({
                        tag: "Text",
                        key: "vwaveAnchorLabel_" + l.key,
                        point: { x: du(barIndex), y: op(du(d.low()), "-", px(16 + n * 14)) },
                        text: l.text,
                        style: { fontSize: 11, fontWeight: "bold", fill: l.color },
                        textAlignment: "centerMiddle",
                    })),
                };
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
            return this.vwap.map(d, i, this.props, barEnd(this, history, i), this.contractInfo, this.chartDescription);
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
    if (isSlot(a)) {
        params[a.prefix + "Mode"]  = predef.paramSpecs.enum(SLOT_MODES, "off");
        params[a.prefix + "Date"]  = predef.paramSpecs.number(0, 1, 0);          // YYYYMMDD
        params[a.prefix + "Time"]  = predef.paramSpecs.number(0, 1, 0);          // HHMM, CT
        params[a.prefix + "Index"] = predef.paramSpecs.number(0, 1, -1000000);   // bar index
    } else {
        params[a.prefix + "Show"] = predef.paramSpecs.bool(true);
    }
    if (a.open === "settle") {
        params.stlProduct = predef.paramSpecs.enum(SETTLE_CHOICES, "auto");
        params.stlTime    = predef.paramSpecs.number(1500, 1, 0);                // HHMM, CT (Custom)
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
