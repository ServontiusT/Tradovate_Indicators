// ============================================================
//  Previous Day & Overnight Levels (PDH / PDL / ONH / ONL)
//  For Tradovate Custom Indicators
//
//  Plots four horizontal levels on the price chart:
//    PDH — Previous Day High  (entire prior session high)
//    PDL — Previous Day Low   (entire prior session low)
//    ONH — Overnight High     (Asian open → NY cash open)
//    ONL — Overnight Low      (Asian open → NY cash open)
//
//  "Previous Day" = the full prior session (e.g. 17:00–16:59 CT),
//  including overnight, pre-market, AND RTH bars.
//
//  All time parameters are in local machine time.
//  Default values assume US Central Time (CT):
//    Session open : 17:00 CT  (CME Globex convention)
//    RTH open     : 08:30 CT  (09:30 ET — NY cash open)
//    Asian open   : 18:00 CT  (08:00 Tokyo JST next day)
//
//  Levels are only drawn for the current session so lines
//  remain perfectly horizontal (no cross-session steps).
//  ONH / ONL only appear once the overnight window closes
//  (at RTH open) so they are always at their final values.
//
//  NOTE: Must be used with the new "Chart" module, not Legacy Chart.
// ============================================================

const predef = require("./tools/predef");
const meta   = require("./tools/meta");
const { du } = require("./tools/graphics");

// ── Helpers ─────────────────────────────────────────────────

function timeToMinutes(hour, minute) {
    return hour * 60 + (minute || 0);
}

/**
 * Session day key — rolls over at sessionOpenHour.
 * Bars before the open hour belong to the previous calendar day's session.
 */
function sessionDayKey(date, openHour) {
    const d = new Date(date);
    if (d.getHours() < openHour) {
        d.setDate(d.getDate() - 1);
    }
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Returns the Date of the most-recent session open (wall clock).
 * Used to restrict output to the current session only.
 */
function currentSessionStart(openHour) {
    const now   = new Date();
    const start = new Date(now);
    start.setMinutes(0, 0, 0);
    if (now.getHours() < openHour) {
        start.setDate(start.getDate() - 1);
    }
    start.setHours(openHour);
    return start;
}

// ── Calculator ──────────────────────────────────────────────

class PreviousDayValues {
    init() {
        this.prevDayHigh = null;
        this.prevDayLow  = null;

        // Full session high / low (all bars, not just RTH)
        this.currDayHigh = -Infinity;
        this.currDayLow  =  Infinity;

        this.onHigh = -Infinity;
        this.onLow  =  Infinity;

        this.lastSessionDay = null;
    }

    map(d) {
        const ts   = d.timestamp();
        const time = timeToMinutes(ts.getHours(), ts.getMinutes());

        const sessOpenHour = this.props.sessionOpenHour;
        const rthOpen      = timeToMinutes(this.props.rthOpenHour, this.props.rthOpenMin);
        const asianOpen    = timeToMinutes(this.props.asianOpenHour, this.props.asianOpenMin);

        // ── Detect session boundary ─────────────────────────
        const sessDay = sessionDayKey(ts, sessOpenHour);

        if (sessDay !== this.lastSessionDay) {
            if (this.lastSessionDay !== null && this.currDayHigh !== -Infinity) {
                this.prevDayHigh = this.currDayHigh;
                this.prevDayLow  = this.currDayLow;
            }
            this.currDayHigh = -Infinity;
            this.currDayLow  =  Infinity;
            this.onHigh      = -Infinity;
            this.onLow       =  Infinity;
            this.lastSessionDay = sessDay;
        }

        // ── Update full-session high / low (every bar) ──────
        this.currDayHigh = Math.max(this.currDayHigh, d.high());
        this.currDayLow  = Math.min(this.currDayLow,  d.low());

        // ── Update overnight high / low (Asian open → RTH open) ─
        // The window may wrap around midnight (e.g. 18:00 → 08:30).
        const inOvernight = asianOpen > rthOpen
            ? (time >= asianOpen || time < rthOpen)   // wraps midnight
            : (time >= asianOpen && time < rthOpen);  // same calendar day

        if (inOvernight) {
            this.onHigh = Math.max(this.onHigh, d.high());
            this.onLow  = Math.min(this.onLow,  d.low());
        }

        // ── Only output for the current session ─────────────
        const sessStart = currentSessionStart(sessOpenHour);
        if (ts < sessStart) return {};

        // ── Build output ────────────────────────────────────
        const result = {};

        if (this.prevDayHigh !== null) {
            result.pdh = this.prevDayHigh;
            result.pdl = this.prevDayLow;
        }

        // ONH / ONL only appear once the overnight window has
        // closed (at RTH open) so the values are final and the
        // lines stay perfectly horizontal — no mid-session steps.
        if (this.onHigh !== -Infinity && time >= rthOpen) {
            result.onh = this.onHigh;
            result.onl = this.onLow;
        }

        // ── Text labels (every labelInterval bars) ──────────
        const barIdx   = d.index();
        const interval = this.props.labelInterval;
        const fSize    = this.props.fontSize;
        const items    = [];

        if (barIdx % interval === 0) {
            if (this.prevDayHigh !== null) {
                items.push({
                    tag:           "Text",
                    key:           `pdh_lbl_${barIdx}`,
                    point:         { x: du(barIdx), y: du(this.prevDayHigh) },
                    text:          `PDH (${this.prevDayHigh.toFixed(2)})`,
                    style:         { fontSize: fSize, fontWeight: "bold", fill: this.props.pdhColor },
                    textAlignment: "centerBottom",
                });
                items.push({
                    tag:           "Text",
                    key:           `pdl_lbl_${barIdx}`,
                    point:         { x: du(barIdx), y: du(this.prevDayLow) },
                    text:          `PDL (${this.prevDayLow.toFixed(2)})`,
                    style:         { fontSize: fSize, fontWeight: "bold", fill: this.props.pdlColor },
                    textAlignment: "centerTop",
                });
            }
            if (this.onHigh !== -Infinity && time >= rthOpen) {
                items.push({
                    tag:           "Text",
                    key:           `onh_lbl_${barIdx}`,
                    point:         { x: du(barIdx), y: du(this.onHigh) },
                    text:          `ONH (${this.onHigh.toFixed(2)})`,
                    style:         { fontSize: fSize, fontWeight: "bold", fill: this.props.onhColor },
                    textAlignment: "centerBottom",
                });
                items.push({
                    tag:           "Text",
                    key:           `onl_lbl_${barIdx}`,
                    point:         { x: du(barIdx), y: du(this.onLow) },
                    text:          `ONL (${this.onLow.toFixed(2)})`,
                    style:         { fontSize: fSize, fontWeight: "bold", fill: this.props.onlColor },
                    textAlignment: "centerTop",
                });
            }
        }

        if (items.length > 0) {
            result.graphics = { items };
        }

        return result;
    }
}

// ── Module exports ──────────────────────────────────────────

module.exports = {
    name:        "PreviousDayValues",
    description: "Previous Day & Overnight Levels (PDH / PDL / ONH / ONL)",
    calculator:  PreviousDayValues,

    inputType:  meta.InputType.BARS,
    areaChoice: meta.AreaChoice.SAME,

    params: {
        // Session times (local machine time; defaults for US Central)
        sessionOpenHour: predef.paramSpecs.number(17, 1, 0),
        rthOpenHour:     predef.paramSpecs.number(8,  1, 0),
        rthOpenMin:      predef.paramSpecs.number(30, 1, 0),
        asianOpenHour:   predef.paramSpecs.number(18, 1, 0),
        asianOpenMin:    predef.paramSpecs.number(0,  1, 0),

        // Line / label colors
        pdhColor: predef.paramSpecs.color("#4488FF"),
        pdlColor: predef.paramSpecs.color("#4488FF"),
        onhColor: predef.paramSpecs.color("#FFD700"),
        onlColor: predef.paramSpecs.color("#FFD700"),

        // Label appearance
        fontSize:      predef.paramSpecs.number(10, 1, 6),
        labelInterval: predef.paramSpecs.number(20, 1, 1),
    },

    plots: {
        pdh: { title: "PDH" },
        pdl: { title: "PDL" },
        onh: { title: "ONH" },
        onl: { title: "ONL" },
    },

    plotter: [
        predef.plotters.singleline("pdh"),
        predef.plotters.singleline("pdl"),
        predef.plotters.singleline("onh"),
        predef.plotters.singleline("onl"),
    ],

    scaler: predef.scalers.multiPath(["pdh", "pdl", "onh", "onl"]),

    schemeStyles: {
        dark: {
            pdh: { color: "#4488FF", lineWidth: 2 },
            pdl: { color: "#4488FF", lineWidth: 2 },
            onh: { color: "#FFD700", lineWidth: 2 },
            onl: { color: "#FFD700", lineWidth: 2 },
        },
    },

    tags: [predef.tags.Channels],
};
