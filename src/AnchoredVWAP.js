/**
 * Anchored VWAP (AVWAP) — Tradovate custom INDICATOR
 * -------------------------------------------------------------------------
 * Up to four independently anchored VWAPs from one indicator instance, each
 * with optional 1, 2 or 3 SD bands. The VWAP math is the same as Vwave's
 * (VWAVE.js), so an anchor set here and the same anchor in Vwave draw the
 * same line:
 *   - Source "Trades" sums each bar's volume profile (every price level and
 *     its volume), not one typical price per bar. A bar with no profile
 *     falls back to (H+L+C)/3. "Bar HLC3" always uses (H+L+C)/3.
 *   - With Trades, a bar belongs to the period its last moment is in, so a
 *     bar that straddles a Date/time anchor is counted in full.
 *   - SD bands are volume-weighted, at fixed 1.0 / 2.0 / 3.0 multiples.
 *   - Running sums are stored per bar, so re-running the forming bar never
 *     double-counts.
 *
 * ---- Why the anchors are numbers, not text -----------------------------
 * The settings dialog does not render text params, so each slot has:
 *
 *   Anchor N Mode    Off | Date/time | Today | Yesterday | Bar index
 *   Anchor N Date    YYYYMMDD, e.g. 20260817   (Date/time mode)
 *   Anchor N Time    HHMM, e.g. 930 = 09:30, 1523 = 15:23, 0 = midnight
 *                    (Date/time, Today, Yesterday modes)
 *   Anchor N Index   bar index, may be negative  (Bar index mode)
 *   Anchor N Bands   0 / 1 / 2 / 3 SD bands
 *
 * Dates and times are Central Time (like Vwave), shifted by "TZ offset".
 *
 * ---- The hybrid handoff -------------------------------------------------
 *   1. Draw an "AVWAP Anchor" marker (AnchoredVWAP-Tool.js) on the bar.
 *   2. SHIFT-hover the marker and read its bar index (often negative).
 *   3. Set a slot's Mode to Bar index and type that number into Index. The
 *      AVWAP starts there, and the chart label prints the anchor bar's date
 *      and time already formatted for the Date and Time fields.
 *   4. Switch the slot's Mode to Date/time and enter those two numbers. The
 *      anchor is now durable and the marker is just a visual reference.
 *
 * Bar indices are relative and can be negative; loading more history shifts
 * them, and a timeframe change invalidates them. Bar index mode is a
 * transfer format, not a resting place.
 *
 * If the label's date does not match the bar you clicked, the drawing tool's
 * index origin and this indicator's differ by a constant. Adjust the Index
 * field by that amount once per chart; step 4 discards it.
 *
 * The dialog's SHIFT section is Tradovate's built-in per-plot bar offset. It
 * slides a finished line sideways; it does not move an anchor. Leave it at 0.
 *
 * Setup:
 *   Code Explorer -> File -> New, paste this file, save, then REMOVE the
 *   indicator from the chart and re-add it. An already-placed instance
 *   keeps its old parameter set and will not show the new fields.
 *
 * Other params:
 *   TZ offset (min)    Minutes your anchor times are ahead of Central Time.
 *                      0 = CT, 60 = ET, -60 = MT, -120 = PT. Labels apply the
 *                      same offset, so what a label shows can be typed back.
 *   VWAP source        Trades (volume profile) | Bar HLC3
 *   Anchor labels      Bar-index anchors only / All anchors / Off
 */

const predef = require("./tools/predef");
const meta = require("./tools/meta");
const { px, du, op } = require("./tools/graphics");

const MAX_ANCHORS = 4;
const MINUTE = 60000;

// ── Central Time clock (same rule as Vwave) ────────────────────────────
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
// CT wall-clock time written as UTC ms -> epoch ms.
function ctWallToMs(local) {
    let ms = local + 360 * MINUTE;
    ms = local - ctOffsetMin(ms) * MINUTE;
    return local - ctOffsetMin(ms) * MINUTE;
}
// Epoch ms -> CT wall-clock time written as UTC ms.
function msToCtWall(ms) {
    return ms + ctOffsetMin(ms) * MINUTE;
}

function shiftMinutes(offsetMinutes) {
    const shift = Number(offsetMinutes);
    return isFinite(shift) ? shift : 0;
}

// HHMM as a number: 930 -> {hours: 9, minutes: 30}. Returns null if invalid.
function splitTime(hhmm) {
    const n = Number(hhmm);
    if (!isFinite(n) || n < 0 || n > 2359) return null;
    const whole = Math.floor(n);
    const hours = Math.floor(whole / 100), minutes = whole % 100;
    if (hours > 23 || minutes > 59) return null;
    return { hours, minutes };
}

// YYYYMMDD as a number: 20260817 -> {year, month, day}. Null if invalid.
function splitDate(yyyymmdd) {
    const n = Number(yyyymmdd);
    if (!isFinite(n) || n < 10000101 || n > 99991231) return null;
    const whole = Math.floor(n);
    const year = Math.floor(whole / 10000), month = Math.floor(whole / 100) % 100, day = whole % 100;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return { year, month, day };
}

/**
 * One anchor spec from a slot's params, or null when the slot is off or
 * misconfigured. A slot that can't be read plots nothing — it never quietly
 * falls back to some other bar.
 */
function buildAnchorSpec(mode, dateNum, timeNum, indexNum, offsetMinutes) {
    if (mode === "barIndex") {
        const index = Number(indexNum);
        return isFinite(index) ? { mode: "barIndex", index: Math.round(index) } : null;
    }
    if (mode !== "datetime" && mode !== "today" && mode !== "yesterday") return null;

    const time = splitTime(timeNum);
    if (time === null) return null;

    let wall;   // the typed time, in the TZ-offset zone, as UTC ms
    if (mode === "datetime") {
        const date = splitDate(dateNum);
        if (date === null) return null;
        wall = Date.UTC(date.year, date.month - 1, date.day, time.hours, time.minutes);
    } else {
        // Resolved at init(), so relative anchors stay current.
        const now = new Date(msToCtWall(Date.now()) + shiftMinutes(offsetMinutes) * MINUTE);
        wall = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(),
            now.getUTCDate() - (mode === "yesterday" ? 1 : 0), time.hours, time.minutes);
    }
    const t = ctWallToMs(wall - shiftMinutes(offsetMinutes) * MINUTE);
    return isFinite(t) ? { mode: "datetime", time: t } : null;
}

function pad2(n) {
    return (n < 10 ? "0" : "") + n;
}

// An instant -> the exact numbers the Date and Time fields expect (round-trips).
function formatForParams(timeMs, offsetMinutes) {
    const d = new Date(msToCtWall(timeMs) + shiftMinutes(offsetMinutes) * MINUTE);
    const y = d.getUTCFullYear(), mo = d.getUTCMonth() + 1, day = d.getUTCDate();
    const h = d.getUTCHours(), mi = d.getUTCMinutes();
    return {
        date: y * 10000 + mo * 100 + day,
        time: h * 100 + mi,
        pretty: y + "-" + pad2(mo) + "-" + pad2(day) + " " + pad2(h) + ":" + pad2(mi),
    };
}

function barIndexOf(d, fallbackIndex) {
    if (d && typeof d.index === "function") {
        const value = d.index();
        if (typeof value === "number" && isFinite(value)) return value;
    }
    return fallbackIndex;
}

// ── Vwave VWAP math ────────────────────────────────────────────────────
// SD multipliers are locked, as in Vwave.
const BAND_PAIRS = { none: 0, one: 1, two: 2, three: 3 };
const BAND_CHOICES = { none: "0 Bands", one: "1 SD Bands", two: "2 SD Bands", three: "3 SD Bands" };
const LINES = [
    { suffix: "",       label: "",       pair: 0, mult:  0, width: 2, lineStyle: 1 },
    { suffix: "Upper1", label: " +1 SD", pair: 1, mult: +1, width: 1, lineStyle: 2 },
    { suffix: "Lower1", label: " -1 SD", pair: 1, mult: -1, width: 1, lineStyle: 2 },
    { suffix: "Upper2", label: " +2 SD", pair: 2, mult: +2, width: 1, lineStyle: 3 },
    { suffix: "Lower2", label: " -2 SD", pair: 2, mult: -2, width: 1, lineStyle: 3 },
    { suffix: "Upper3", label: " +3 SD", pair: 3, mult: +3, width: 1, lineStyle: 4 },
    { suffix: "Lower3", label: " -3 SD", pair: 3, mult: -3, width: 1, lineStyle: 4 },
];

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

// End time of bar j: open + bar length on minute and daily charts, otherwise
// the next bar's open (NaN on the last bar).
function barEnd(calc, history, j) {
    const start = history.get(j).timestamp().getTime();
    const cd = calc.chartDescription;
    if (cd && cd.underlyingType === "MinuteBar" && cd.elementSizeUnit === "UnderlyingUnits")
        return start + cd.elementSize * MINUTE;
    if (cd && cd.underlyingType === "DailyBar" && cd.elementSizeUnit === "UnderlyingUnits")
        return start + cd.elementSize * 1440 * MINUTE;
    return j + 1 < history.size() ? history.get(j + 1).timestamp().getTime() : NaN;
}

// ── The indicator ──────────────────────────────────────────────────────
class anchoredVWAP {
    init() {
        const p = this.props;
        this.slots = [];
        for (let n = 1; n <= MAX_ANCHORS; ++n) {
            this.slots.push({
                spec: buildAnchorSpec(p["anchor" + n + "Mode"], p["anchor" + n + "Date"],
                    p["anchor" + n + "Time"], p["anchor" + n + "Index"], p.tzOffsetMinutes),
                bands: p["anchor" + n + "Bands"],
                sums: [],           // per-bar running sums; null before the anchor
            });
        }
    }

    map(d, i, history) {
        try {
            return this.compute(d, i, barEnd(this, history, i));
        } catch (e) {
            return {};              // skip this bar
        }
    }

    compute(d, i, endMs) {
        const start = d.timestamp().getTime();
        if (!isFinite(start)) return {};

        const bar = this.props.vwapSource === "hlc3" ? null : profileSums(d);
        const at = bar && endMs > start ? Math.max(start, endMs - 1) : start;
        let added = bar;
        if (!added) {
            let vol = d.volume();
            if (typeof vol !== "number" || !isFinite(vol) || vol < 0) vol = 0;
            const tp = (d.high() + d.low() + d.close()) / 3;
            if (!isFinite(tp)) return {};
            added = { v: vol, pv: tp * vol, p2v: tp * tp * vol };
        }

        const barIndex = barIndexOf(d, i);
        const result = {};
        const labels = [];

        this.slots.forEach((slot, k) => {
            const spec = slot.spec;
            if (spec === null) return;
            const reached = spec.mode === "barIndex" ? barIndex >= spec.index : at >= spec.time;
            if (!reached) { slot.sums[i] = null; return; }

            const prev = slot.sums[i - 1];
            const s = prev ? { v: prev.v, pv: prev.pv, p2v: prev.p2v } : { v: 0, pv: 0, p2v: 0 };
            s.v += added.v; s.pv += added.pv; s.p2v += added.p2v;
            slot.sums[i] = s;       // the forming bar overwrites its own slot each tick

            const labelMode = this.props.anchorLabels;
            const wantLabel = labelMode === "all" || (labelMode === "transfer" && spec.mode === "barIndex");
            if (!prev && wantLabel) {
                // For a bar-index anchor, print the numbers to type into the
                // Date and Time fields to make this anchor durable.
                const f = formatForParams(start, this.props.tzOffsetMinutes);
                labels.push({
                    slot: k,
                    text: spec.mode === "barIndex"
                        ? "▲ " + (k + 1) + ": date " + f.date + " time " + f.time + " (#" + barIndex + ")"
                        : "▲ " + (k + 1) + ": " + f.pretty,
                });
            }

            if (!(s.v > 0)) return;
            const pairs = BAND_PAIRS[slot.bands in BAND_PAIRS ? slot.bands : "none"];
            const mid = s.pv / s.v, sd = sdOf(s);
            for (const line of LINES) {
                if (line.pair <= pairs) result["avwap" + (k + 1) + line.suffix] = mid + line.mult * sd;
            }
        });

        if (labels.length > 0) {
            result.graphics = {
                items: labels.map((label, n) => ({
                    tag: "Text",
                    key: "avwapAnchorLabel" + label.slot,
                    point: {
                        x: du(barIndex),
                        // Stack labels when several anchors share a bar.
                        y: op(du(d.low()), "-", px(16 + n * 14)),
                    },
                    text: label.text,
                    style: { fontSize: 11, fontWeight: "bold", fill: "#f0a020" },
                    textAlignment: "centerMiddle",
                })),
            };
        }
        return result;
    }
}

// ── Params, plots and styles ───────────────────────────────────────────
const anchorModes = {
    off: "Off",
    datetime: "Date/time",
    today: "Today",
    yesterday: "Yesterday",
    barIndex: "Bar index",
};

const params = {};
for (let n = 1; n <= MAX_ANCHORS; ++n) {
    params["anchor" + n + "Mode"]  = { type: "enum", enumSet: anchorModes, def: n === 1 ? "today" : "off" };
    params["anchor" + n + "Date"]  = predef.paramSpecs.number(0, 1, 0);
    params["anchor" + n + "Time"]  = predef.paramSpecs.number(0, 1, 0);
    params["anchor" + n + "Index"] = predef.paramSpecs.number(0, 1, -1000000);
    params["anchor" + n + "Bands"] = { type: "enum", enumSet: BAND_CHOICES, def: "none" };
}
params.tzOffsetMinutes = predef.paramSpecs.number(0, 15, -1440);
params.vwapSource = { type: "enum", enumSet: { trades: "Trades (volume profile)", hlc3: "Bar HLC3" }, def: "trades" };
params.anchorLabels = {
    type: "enum",
    enumSet: { transfer: "Bar-index anchors only", all: "All anchors", off: "Off" },
    def: "transfer",
};

const COLORS = {
    dark:  ["#f0a020", "#4ea1f0", "#5fd08a", "#d47ff0"],
    light: ["#c07800", "#1f6fbf", "#2f9160", "#9b3fbf"],
};
const plots = {}, schemeStyles = { dark: {}, light: {} };
for (let n = 1; n <= MAX_ANCHORS; ++n) {
    for (const line of LINES) {
        const key = "avwap" + n + line.suffix;
        plots[key] = { title: "AVWAP " + n + line.label };
        for (const scheme in COLORS) {
            schemeStyles[scheme][key] = { color: COLORS[scheme][n - 1], lineWidth: line.width, lineStyle: line.lineStyle };
        }
    }
}

module.exports = {
    name: "anchoredVWAP",
    description: "Anchored VWAP",
    calculator: anchoredVWAP,
    inputType: meta.InputType.BARS,
    areaChoice: meta.AreaChoice.OVERLAY,
    requirements: { volumeProfiles: true },
    tags: ["My Indicators"],
    params,
    plots,
    schemeStyles,
};
