// Vwave: session anchored VWAP with 1.0 / 2.0 SD bands.
// Port of the MotiveWave Vwave study (VwapModule + SessionVwap + SessionClock).
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
const RTH_OPEN = 8 * 60 + 30, GLOBEX_OPEN = 17 * 60;   // CT minutes of day

// The session ("RTH" | "GLOBEX") and trading day of a bar open time.
// A trading day runs 17:00 to 17:00 CT and is named by the date it closes on.
function sessionOf(ms) {
    const ctMin = Math.floor(ms / 60000) + ctOffsetMin(ms);
    const minute = ((ctMin % 1440) + 1440) % 1440;
    const day = Math.floor(ctMin / 1440) + (minute >= GLOBEX_OPEN ? 1 : 0);
    return { session: (minute >= RTH_OPEN && minute < GLOBEX_OPEN) ? "RTH" : "GLOBEX", day };
}

// ── VwapModule ─────────────────────────────────────────────────────────
const SD_MULT_1 = 1.0, SD_MULT_2 = 2.0;                // locked by design
const BAND_PAIRS = { none: 0, one: 1, two: 2 };
const LINES = [
    { key: "vwap",   pair: 0, mult: 0 },
    { key: "upper1", pair: 1, mult: +SD_MULT_1 },
    { key: "lower1", pair: 1, mult: -SD_MULT_1 },
    { key: "upper2", pair: 2, mult: +SD_MULT_2 },
    { key: "lower2", pair: 2, mult: -SD_MULT_2 },
];

// Shared with SystemOne. `opts.showVwap` / `opts.showBands` default to true.
function vwapModule() {
    let sums = [];                      // replaces series.setDouble(SUM_*, SESSION)
    return {
        name: "VWAP",
        init() { sums = []; },
        map(d, i, opts) {
            const out = {};
            const { session, day } = sessionOf(d.timestamp().getTime());
            const mode = opts.sessionMode;
            const inSession = mode === "both" || (mode === "rth") === (session === "RTH");
            if (!inSession) {           // empty values break the lines
                sums[i] = undefined;
                return out;
            }

            // Continue the previous bar's sums only within the same session.
            const prev = sums[i - 1];
            const s = (prev && prev.day === day)
                ? { day, v: prev.v, pv: prev.pv, p2v: prev.p2v }
                : { day, v: 0, pv: 0, p2v: 0 };
            const tp = (d.high() + d.low() + d.close()) / 3;
            const vol = d.volume();
            s.v += vol; s.pv += tp * vol; s.p2v += tp * tp * vol;
            sums[i] = s;                // the forming bar overwrites its own slot each tick

            if (!(s.v > 0)) return out;
            const mid = s.pv / s.v;
            const sd = Math.sqrt(Math.max(0, s.p2v / s.v - mid * mid));
            const pairs = BAND_PAIRS[opts.bandMode];
            for (const line of LINES) {
                const shown = line.pair === 0
                    ? opts.showVwap !== false
                    : opts.showBands !== false && line.pair <= pairs;
                if (shown) out[line.key] = mid + line.mult * sd;
            }
            return out;
        },
    };
}

class vwave {
    init() {
        this.vwap = vwapModule();
        this.vwap.init();
    }
    map(d, i) {
        return this.vwap.map(d, i, this.props);
    }
}

module.exports = {
    name: "Vwave",
    description: "Session anchored VWAP (RTH, Ext or Both) with 1.0 and 2.0 standard deviation bands.",
    calculator: vwave,
    inputType: meta.InputType.BARS,
    areaChoice: meta.AreaChoice.OVERLAY,
    tags: ["Servontius"],
    params: {
        sessionMode: predef.paramSpecs.enum({ rth: "RTH Session", ext: "Ext Session", both: "Both" }, "rth"),
        bandMode: predef.paramSpecs.enum({ none: "0 Bands", one: "1 SD Bands", two: "2 SD Bands" }, "one"),
    },
    plots: {
        vwap:   { title: "VWAP" },
        upper1: { title: "+1 SD" },
        lower1: { title: "-1 SD" },
        upper2: { title: "+2 SD" },
        lower2: { title: "-2 SD" },
    },
    schemeStyles: {
        dark: {
            vwap:   predef.styles.plot({ color: "#2196F3", lineWidth: 2 }),
            upper1: predef.styles.plot({ color: "#FFB74D", lineWidth: 1, lineStyle: 2 }),
            lower1: predef.styles.plot({ color: "#FFB74D", lineWidth: 1, lineStyle: 2 }),
            upper2: predef.styles.plot({ color: "#9575CD", lineWidth: 1, lineStyle: 3 }),
            lower2: predef.styles.plot({ color: "#9575CD", lineWidth: 1, lineStyle: 3 }),
        },
    },
};
