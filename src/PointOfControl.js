// ============================================================
//  Point of Control (POC) Boxes — Current Session Only
//  For Tradovate Custom Indicators
//
//  Draws a filled box at the highest-volume price level (POC)
//  for every candlestick in the active trading session only.
//  Bars from prior sessions receive no graphics, preventing
//  box accumulation across days.
//
//  Session boundary: configurable open hour (default 17:00),
//  matching the CME / Globex session (17:00 – 15:59 CT).
//  Times are evaluated in the browser's local timezone; set
//  sessionOpenHour to match your machine's local equivalent
//  of 17:00 CT if you are not in the Central timezone.
//
//  POC is the price level with the highest total traded volume
//  within the bar's volume profile.
//
//  REQUIRES: volumeProfiles = true (set in requirements below).
//  The chart must provide per-bar volume-profile data (i.e. a
//  Footprint or Volume Profile chart type in Tradovate).
//
//  NOTE: Must be used with the new "Chart" module, not Legacy Chart.
// ============================================================

const predef = require("./tools/predef");
const meta   = require("./tools/meta");
const { du } = require("./tools/graphics");

// ── Session helpers ───────────────────────────────────────────

/**
 * Returns the Date of the most-recent session open.
 * openHour is evaluated in LOCAL machine time (default 17 for CT).
 */
function currentSessionStart(openHour) {
    const now   = new Date();
    const start = new Date(now);
    start.setMinutes(0, 0, 0);

    if (now.getHours() < openHour) {
        // We are before the open hour — the session started yesterday.
        start.setDate(start.getDate() - 1);
    }

    start.setHours(openHour);
    return start;
}

// ── POC finder ────────────────────────────────────────────────

/**
 * Returns the price level with the highest total volume from the
 * bar's volume profile, or null when profile data is unavailable.
 *
 * VolumeProfileLevel fields: { price, vol, bidVol, askVol }
 * Uses bidVol + askVol as the primary metric (matches what footprint
 * charts display). Falls back to vol when bid/ask are absent.
 */
function findPOC(d) {
    let levels;
    try { levels = d.profile(); } catch (_) { return null; }

    if (!levels || levels.length === 0) return null;

    let maxVol   = 0;
    let pocPrice = null;

    for (const lvl of levels) {
        const bidAsk = (lvl.bidVol || 0) + (lvl.askVol || 0);
        const total  = bidAsk > 0 ? bidAsk : (lvl.vol || 0);

        if (total > maxVol) {
            maxVol   = total;
            pocPrice = lvl.price;
        }
    }

    return pocPrice;
}

// ── Calculator ────────────────────────────────────────────────

class PointOfControl {
    init() {
        // Prefer the instrument's actual tick size; fall back to user param.
        this.tickSize = (this.contractInfo && this.contractInfo.tickSize)
            ? this.contractInfo.tickSize
            : this.props.tickSize;
    }

    map(d) {
        // Skip bars that fall outside the current trading session.
        // currentSessionStart() uses the real wall clock so the threshold
        // advances automatically when the session open hour is crossed.
        const sessStart = currentSessionStart(this.props.sessionOpenHour);
        if (d.timestamp() < sessStart) return {};

        const pocPrice = findPOC(d);
        if (pocPrice === null) return {};

        const tick    = this.tickSize;
        const color   = this.props.pocColor;
        const opacity = this.props.opacity / 100;  // stored as 0-100 integer
        const barIdx  = d.index();

        // Four corners of the box in price/bar-index domain units.
        // Using Polygon avoids the Rectangle's size ambiguity (size only
        // accepts px() values, not du()), giving exact tick-level alignment.
        const corners = [
            { x: du(barIdx - 0.5), y: du(pocPrice) },
            { x: du(barIdx + 0.5), y: du(pocPrice) },
            { x: du(barIdx + 0.5), y: du(pocPrice + tick) },
            { x: du(barIdx - 0.5), y: du(pocPrice + tick) },
        ];

        return {
            graphics: {
                items: [
                    // Filled interior
                    {
                        tag: "Shapes",
                        key: `poc_fill_${barIdx}`,
                        primitives: [{ tag: "Polygon", points: corners }],
                        fillStyle: { color, opacity },
                    },
                    // Solid border — remains visible at any opacity level
                    {
                        tag: "ContourShapes",
                        key: `poc_border_${barIdx}`,
                        primitives: [{ tag: "Polygon", points: corners }],
                        lineStyle: { color, lineWidth: 1 },
                    },
                ],
            },
        };
    }
}

// ── Module exports ────────────────────────────────────────────

module.exports = {
    name:        "PointOfControl",
    description: "POC Boxes — Current Session Only",
    calculator:  PointOfControl,

    inputType:  meta.InputType.BARS,
    areaChoice: meta.AreaChoice.SAME,  // overlay on the main price chart

    // Enables d.profile() — required for per-bar volume-profile data.
    requirements: {
        volumeProfiles: true,
    },

    params: {
        pocColor:        predef.paramSpecs.color("#FFD700"),        // default: gold
        opacity:         predef.paramSpecs.number(70, 5, 10),       // 10–100 (%)
        sessionOpenHour: predef.paramSpecs.number(17, 1, 0),        // local hour for session open
        tickSize:        predef.paramSpecs.number(0.25, 0.01, 0.01),// fallback if contractInfo unavailable
    },

    plots: {},

    tags: [predef.tags.Volumes],
};
