// Delta: bar delta (buy volume - sell volume) as a green / red histogram, or
// cumulative delta as a line, in a pane under the price chart.
// Port of the delta panes of the MotiveWave Vwave study v2.3 (DeltaModule +
// the bar delta side of BarTradeCache + the RTH / trading-day anchors of
// VwapModule and SessionClock).
//
// Differences from MotiveWave:
//  - A Tradovate indicator draws into one pane only, so the Delta and Cum
//    Delta panes are one indicator with a "Show" setting: add it to the chart
//    twice, once set to Delta and once to Cumulative, for both panes.
//  - Delta comes from each bar's volume at price (d.profile()): askVol -
//    bidVol, i.e. how the feed classified each trade. Tradovate gives an
//    indicator no tick stream, so this is MotiveWave's "Feed" Delta Method and
//    the Bid/Ask Quote and Tick Rule methods are gone. Without a profile it
//    falls back to the bar's offerVolume() - bidVolume() if the feed has them.
//  - A bar with no bid / ask volume has no delta: it draws no histogram bar
//    and leaves the cumulative delta where it was, as in MotiveWave.
//  - A bar's delta goes to the period its bar opens in, so use an intraday
//    chart (bars that do not straddle 08:30 or 17:00 CT).
//  - Colors are set in Tradovate's own style settings, not as params.
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
// A bar time on the CT clock: its CT date (epoch day) and minute of day.
function ctClock(ms) {
    const ctMin = Math.floor(ms / 60000) + ctOffsetMin(ms);
    const date = Math.floor(ctMin / 1440);
    return { date, minute: ctMin - date * 1440 };
}
const RTH_OPEN = 8 * 60 + 30, GLOBEX_OPEN = 17 * 60;   // CT minutes of day

// Where the cumulative delta starts again: the RTH VWAP's anchor (Monday -
// Friday) or the Overnight VWAP's (17:00 CT, Sunday - Thursday).
const RESETS = {
    rth: { open: RTH_OPEN,    opensSunday: false },
    day: { open: GLOBEX_OPEN, opensSunday: true },
};
function anchorsOn(r, dow) {
    return r.opensSunday ? dow !== 5 && dow !== 6 : dow !== 6 && dow !== 0;
}
// The most recent reset at or before the bar, as CT minutes since the epoch.
function periodOf(r, clock) {
    let date = clock.date;
    if (r.open > clock.minute) date -= 1;
    while (!anchorsOn(r, (date + 4) % 7)) date -= 1;   // epoch day 0 was a Thursday
    return date * 1440 + r.open;
}

// Buy volume - sell volume of one bar, or null if the feed has no bid / ask
// volume for it.
function barDelta(d) {
    const levels = typeof d.profile === "function" ? d.profile() : null;
    if (levels && levels.length) {
        let ask = 0, bid = 0;
        for (const lv of levels) { ask += lv.askVol || 0; bid += lv.bidVol || 0; }
        return ask + bid > 0 ? ask - bid : null;
    }
    if (typeof d.offerVolume === "function" && typeof d.bidVolume === "function") {
        const ask = d.offerVolume() || 0, bid = d.bidVolume() || 0;
        return ask + bid > 0 ? ask - bid : null;
    }
    return null;
}

// ── The indicator ──────────────────────────────────────────────────────
class delta {
    init() {
        this.sums = [];                 // per bar: { period, cum }; the forming bar overwrites its own slot
    }

    map(d, i) {
        const show = this.props.show === "cumulative" ? "cumulative" : "delta";
        const reset = RESETS[this.props.reset] || RESETS.rth;
        const dlt = barDelta(d);

        // The cumulative delta continues while the bar is in the same RTH or
        // trading-day period as the bar before it.
        const period = periodOf(reset, ctClock(d.timestamp().getTime()));
        const prev = this.sums[i - 1];
        let cum = prev !== undefined && prev.period === period ? prev.cum : 0;
        if (dlt !== null) cum += dlt;
        this.sums[i] = { period, cum };

        const out = { zero: 0 };
        if (show === "cumulative") out.cumDelta = cum;
        else if (dlt !== null) out[dlt >= 0 ? "deltaPos" : "deltaNeg"] = dlt;
        return out;
    }
}

module.exports = {
    name: "Delta",
    description: "Volume Delta",
    calculator: delta,
    inputType: meta.InputType.BARS,
    areaChoice: meta.AreaChoice.NEW,
    requirements: { volumeProfiles: true },
    tags: ["Servontius"],
    params: {
        show:  predef.paramSpecs.enum({ delta: "Delta", cumulative: "Cumulative" }, "delta"),
        reset: predef.paramSpecs.enum({ rth: "RTH Open (08:30 CT)", day: "Trading Day (17:00 CT)" }, "rth"),
    },
    plots: {
        deltaPos: { title: "Positive Delta" },
        deltaNeg: { title: "Negative Delta" },
        cumDelta: { title: "Cumulative Delta" },
        zero:     { title: "Zero", displayOnly: true },
    },
    plotter: [
        { type: "columns", field: "deltaPos" },
        { type: "columns", field: "deltaNeg" },
        { type: "multiline", fields: ["zero", "cumDelta"] },
    ],
    schemeStyles: {
        dark: {
            deltaPos: predef.styles.plot({ color: "#26A69A" }),
            deltaNeg: predef.styles.plot({ color: "#EF5350" }),
            cumDelta: predef.styles.plot({ color: "#2196F3", lineWidth: 2 }),
            zero:     predef.styles.plot({ color: "#808080", lineWidth: 1 }),
        },
    },
};
