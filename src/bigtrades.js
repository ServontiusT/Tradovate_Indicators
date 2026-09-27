// ============================================================
//  Big Trades — Tradovate Custom Indicator
// ------------------------------------------------------------
//  Plots large trades as filled, size-scaled bubbles at the price and time
//  they printed, colored by aggressor side (buy vs sell) and labeled with
//  the trade size when the label fits inside the bubble.
//
//  HOW IT GETS TRADES — READ THIS FIRST
//  I originally built this for Motivewave using the Java SDK  which pulled 
//  raw ticks for each bar with Instrument.forEachTick().
//  Tradovate custom indicators have no equivalent: map() only receives bars
//  (OHLC, volume, bidVolume, offerVolume, profile — see BarInputEntity in the
//  custom-indicator docs). The raw tick stream (price, size, bid, ask, tick
//  id) exists only in the market-data WebSocket API, which indicators can't
//  reach.
//
//  So this indicator runs on a 1-TICK CHART, where every bar IS one trade
//  print: close() = trade price, volume() = trade size, timestamp() = trade
//  time, and bidVolume()/offerVolume() = Tradovate's aggressor split for that
//  print. On any other chart type it draws a warning instead of bubbles,
//  because a bar's volume is not a trade size (see requireOneTickChart).
//
//  Install: Code Explorer -> File -> New, paste, save, add to a 1-tick chart.
//  Must be used with the new "Chart" module, not Legacy Chart.
// ============================================================

const predef = require("./tools/predef");
const meta   = require("./tools/meta");
const { du, px, op } = require("./tools/graphics");

// ---------------- constants ----------------

// Minimum rolling-population sample before Automatic mode or z-score sizing
// trusts the mean/stddev. Below this, Automatic mode plots nothing and
// bubbles fall back to the minimum size.
const MIN_STATS_COUNT = 30;

// Automatic threshold: mean + multiplier x stddev
const INTENSITY_SD = { low: 1.5, medium: 2.5, strong: 4.0 };

// OPACITY IS A PERCENT (0-100)
const OP_FILL   = 75;
const OP_BORDER = 90;

const CHAR_W = 0.55;            // approx glyph width as a fraction of font size (as in Prey)
const MIN_LABEL_FONT = 7;
const LABEL_FONT_FRACTION = 0.42;

const DEBUG_EVERY_MS = 2000;    // console status line at most this often
const WARN_COLOR = "#EF6C00";   // same warning color as Prey
const MAX_REMEMBERED_BARS = 5000;  // bars whose bubbles are kept for re-emission

// ---------------- small helpers ----------------

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
}

// Number param with an upper bound (predef.paramSpecs.number has no max).
function num(def, step, min, max) {
    return { type: "number", def, restrictions: { step, min, max } };
}

function barTime(d) {
    const ts = typeof d.timestamp === "function" ? d.timestamp() : d.date;
    return ts instanceof Date ? ts.getTime() : +ts;
}

function isLastBar(d, i, history) {
    if (typeof d.isLast === "function") return d.isLast();
    return !!history && typeof history.size === "function" && i === history.size() - 1;
}

function textWidth(txt, fs) {
    return Math.ceil(fs * CHAR_W * txt.length);
}

// Java fmtSize(): whole numbers print without decimals.
function fmtSize(size) {
    const r = Math.round(size);
    if (Math.abs(size - r) < 1e-6) return String(r);
    return String(+size.toFixed(2));
}

// One 1-tick bar -> one trade print
function readPrint(d, i) {
    return {
        x:     typeof d.index === "function" ? d.index() : i,   // chart x must come from d.index()
        t:     barTime(d),
        price: d.close(),
        vol:   d.volume() || 0,
        bid:   typeof d.bidVolume === "function"   ? (d.bidVolume()   || 0) : 0,
        ask:   typeof d.offerVolume === "function" ? (d.offerVolume() || 0) : 0,
    };
}

// ---------------- rolling trade-size statistics ----------------

/**
 * Fixed-capacity circular buffer of trade sizes with O(1) mean/stddev.
 * Direct port of the Java RollingStats. Feeds both the Automatic threshold
 * and z-score bubble sizing.
 */
class RollingStats {
    constructor(capacity) {
        this.buf   = new Float64Array(Math.max(1, Math.floor(capacity)));
        this.size  = 0;
        this.head  = 0;     // index of the oldest sample
        this.sum   = 0;
        this.sumSq = 0;
    }

    capacity() { return this.buf.length; }
    count()    { return this.size; }

    add(v) {
        const buf = this.buf;
        if (this.size < buf.length) {
            buf[(this.head + this.size) % buf.length] = v;
            this.size++;
        } else {
            const old = buf[this.head];
            this.sum   -= old;
            this.sumSq -= old * old;
            buf[this.head] = v;
            this.head = (this.head + 1) % buf.length;
        }
        this.sum   += v;
        this.sumSq += v * v;
    }

    mean() { return this.size > 0 ? this.sum / this.size : 0; }

    stddev() {
        if (this.size < 2) return 0;
        const m = this.mean();
        const variance = this.sumSq / this.size - m * m;
        return variance > 0 ? Math.sqrt(variance) : 0;
    }
}

// ---------------- trade classification + collection ----------------

/**
 * Port of the Java BigTradeScanner. Receives prints in order, optionally
 * folds same-millisecond, same-side prints into one VWAP trade, then for
 * each completed trade: decides "big" per Filter Mode against the population
 * as it stood BEFORE the trade, sizes it by z-score, and (only when
 * `mutate` is true) adds the trade to the population.
 *
 * The persistent scanner (mutate = true) sees each print exactly once.
 * fork() makes a read-only copy used to preview the newest print, so live
 * previews can never inflate the population — same split as the Java
 * study's permanent vs. GROUP_LIVE scans. finish() flushes any open
 * aggregate.
 */
class Scanner {
    constructor(stats, cfg, mutate) {
        this.stats  = stats;
        this.cfg    = cfg;
        this.mutate = mutate;
        this.hits   = [];

        this.lastPrice = NaN;
        this.lastBuy   = true;

        // Pending sweep aggregate: { t, x, buy, vol, pv } or null
        this.pending = null;
    }

    fork() {
        const s = new Scanner(this.stats, this.cfg, false);
        s.lastPrice = this.lastPrice;
        s.lastBuy   = this.lastBuy;
        s.pending   = this.pending ? Object.assign({}, this.pending) : null;
        return s;
    }

    onPrint(p) {
        if (!(p.price > 0) || !(p.vol > 0)) return;   // non-trade print — skip

        // Tick rule is tracked for every raw print so it can back-fill the
        // Feed method when a print carries no aggressor side.
        const tickRuleBuy = Number.isNaN(this.lastPrice) ? this.lastBuy
            : p.price > this.lastPrice || (p.price === this.lastPrice && this.lastBuy);
        this.lastPrice = p.price;
        this.lastBuy   = tickRuleBuy;

        const buy = this.classifyBuy(p, tickRuleBuy);

        if (!this.cfg.aggregate) {
            this.processCompletedTrade(p.x, p.t, p.price, p.vol, buy);
            return;
        }

        const pd = this.pending;
        if (pd && pd.t === p.t && pd.buy === buy) {
            // Another fragment of the same sweep — fold in.
            pd.vol += p.vol;
            pd.pv  += p.price * p.vol;
            pd.x    = p.x;          // bubble sits on the last fragment, as in Java
            return;
        }

        // Different timestamp or side — the previous aggregate is complete.
        this.flushPending();
        this.pending = { t: p.t, x: p.x, buy, vol: p.vol, pv: p.price * p.vol };
    }

    /** Call once after the print stream ends (preview forks only). */
    finish() {
        this.flushPending();
    }

    flushPending() {
        const pd = this.pending;
        this.pending = null;
        if (!pd || pd.vol <= 0) return;
        this.processCompletedTrade(pd.x, pd.t, pd.pv / pd.vol, pd.vol, pd.buy);
    }

    classifyBuy(p, tickRuleBuy) {
        if (this.cfg.method === "tickRule") return tickRuleBuy;
        // Feed: on a 1-tick bar, offer volume = lifted the ask (buy),
        // bid volume = hit the bid (sell).
        if (p.ask > p.bid) return true;
        if (p.bid > p.ask) return false;
        return tickRuleBuy;
    }

    processCompletedTrade(x, t, price, vol, buy) {
        const c = this.cfg, st = this.stats;
        const haveStats = st.count() >= MIN_STATS_COUNT;
        const mean = haveStats ? st.mean()   : 0;
        const sd   = haveStats ? st.stddev() : 0;

        const big = c.auto
            ? haveStats && sd > 0 && vol >= mean + c.multiplier * sd
            : vol >= c.minSize;

        if (big) {
            const z = sd > 0 ? Math.max(0, (vol - mean) / sd) : 0;
            const frac = Math.max(0, Math.min(1, z / c.sdScale));
            const dia = Math.round(c.minPx + (c.maxPx - c.minPx) * frac);
            this.hits.push({ x, t, price, size: vol, buy, dia });
        }

        if (this.mutate) st.add(vol);
    }
}

// ---------------- calculator ----------------

class BigTrades {
    init() {
        const p = this.props;
        this.cfg = {
            auto:       p.filterMode !== "manual",
            minSize:    Math.max(1, Number(p.minTradeSize) || 100),
            multiplier: INTENSITY_SD[p.intensity] || INTENSITY_SD.medium,
            sdScale:    Math.max(0.1, Number(p.sdScale) || 3),
            minPx:      0,
            maxPx:      0,
            method:     p.classifyMethod === "tickRule" ? "tickRule" : "feed",
            aggregate:  !!p.aggregateSweeps,
            buyColor:   p.buyColor,
            sellColor:  p.sellColor,
            showLabel:  !!p.showLabel,
            labelColor: p.labelColor,
            labelFontSize: clamp(Math.round(p.labelFontSize), 6, 30),
        };
        this.cfg.minPx = clamp(Math.round(p.minBubblePx), 2, 100);
        this.cfg.maxPx = Math.max(this.cfg.minPx, clamp(Math.round(p.maxBubblePx), 4, 200));

        this.stats   = new RollingStats(clamp(Math.round(p.statsWindow), 50, 50000));
        this.scanner = new Scanner(this.stats, this.cfg, true);

        this.mode      = null;   // chart-type check, resolved on first map()
        this.held      = null;   // newest print: previewed, not yet committed
        this.lastIndex = -1;
        this.barItems  = [];     // committed bubbles owned by bar lastIndex
        this.remembered = new Map();   // bar index -> its committed bubbles

        this.prints    = 0;
        this.hitSerial = 0;
        this.debugAt   = 0;
    }

    map(d, i, history) {
        if (!this.mode) this.mode = this.resolveMode();
        const last = isLastBar(d, i, history);

        if (!this.mode.ok) return last ? this.warning(d) : {};

        if (i > this.lastIndex) {
            // A later print exists, so the held one is closed: commit it once.
            // Bubbles confirmed by that commit belong to THIS bar's output.
            this.lastIndex = i;
            this.barItems = [];
            if (this.held) this.commit(this.held);
            if (this.barItems.length) this.remember(i, this.barItems);
        } else if (i < this.lastIndex) {
            // Re-call for an already-committed bar: never count it twice,
            // just hand back whatever it owned.
            const items = this.remembered.get(i);
            return items ? { graphics: { items } } : {};
        }
        // New newest print, or a refresh of it.
        this.held = readPrint(d, i);

        const items = this.barItems.slice();
        if (last) {
            items.push(this.liveContainer());
            this.debugStatus();
        }
        return items.length ? { graphics: { items } } : {};
    }

    // ---------------- pipeline ----------------

    commit(p) {
        this.prints++;
        this.scanner.onPrint(p);
        const hits = this.scanner.hits;
        for (const h of hits) this.barItems.push(this.bubble(h, `bt_${this.hitSerial++}`));
        hits.length = 0;
    }

    remember(i, items) {
        this.remembered.set(i, items);
        if (this.remembered.size > MAX_REMEMBERED_BARS) {
            this.remembered.delete(this.remembered.keys().next().value);
        }
    }

    // Read-only preview of the newest print and any open aggregate. Always
    // returned under the same global key, so an empty preview clears the
    // previous one (same pattern as Prey's containers).
    liveContainer() {
        const fork = this.scanner.fork();
        if (this.held) fork.onPrint(this.held);
        fork.finish();
        const children = fork.hits.map((h, k) => this.bubble(h, `bt_live_${k}`));
        return { tag: "Container", key: "bt_live", global: true, children };
    }

    // ---------------- drawing ----------------

    // Port of BubbleFigure: filled circle + 1px border, label centered
    // inside only when it fits. Radius is in pixels, so bubbles keep their
    // size through zoom, as in MotiveWave.
    bubble(h, key) {
        const c = this.cfg;
        const color = h.buy ? c.buyColor : c.sellColor;
        const circle = [{ tag: "Circle", center: { x: du(h.x), y: du(h.price) }, radius: h.dia / 2 }];
        const children = [
            { tag: "Shapes", key: `${key}_f`, primitives: circle,
              fillStyle: { color, opacity: OP_FILL } },
            { tag: "ContourShapes", key: `${key}_e`, primitives: circle,
              lineStyle: { lineWidth: 1, color, opacity: OP_BORDER } },
        ];
        if (c.showLabel) {
            const label = this.bubbleLabel(h, `${key}_t`);
            if (label) children.push(label);
        }
        return { tag: "Container", key, children };
    }

    bubbleLabel(h, key) {
        const c = this.cfg;
        const txt = fmtSize(h.size);
        // Shrink the font to fit small bubbles rather than spilling out.
        const fs = Math.floor(Math.max(MIN_LABEL_FONT, Math.min(c.labelFontSize, h.dia * LABEL_FONT_FRACTION)));
        if (textWidth(txt, fs) > h.dia - 2 || fs > h.dia) return null;
        return {
            tag: "Text", key,
            point: { x: du(h.x), y: du(h.price) },
            text: txt,
            style: { fontSize: fs, fill: c.labelColor },
            textAlignment: "centerMiddle",
        };
    }

    // ---------------- chart-type check ----------------

    resolveMode() {
        const cd = this.chartDescription;
        const desc = cd
            ? `${cd.underlyingType} / ${cd.elementSize} ${cd.elementSizeUnit}`
            : "unknown";
        const oneTick = !!cd && cd.underlyingType === "Tick"
            && cd.elementSizeUnit === "UnderlyingUnits"
            && Number(cd.elementSize) === 1;
        // If the runtime doesn't report a chart description at all, proceed
        // rather than blocking the indicator; the debug line shows "unknown".
        const ok = oneTick || !cd || !this.props.requireOneTickChart;
        if (this.props.debug) {
            console.log(`[BigTrades] chart=${desc} oneTick=${oneTick} ` +
                        `enforce=${!!this.props.requireOneTickChart} -> ${ok ? "running" : "warning only"}`);
        }
        return { ok, oneTick, desc };
    }

    warning(d) {
        const fs = 12;
        const txt = `Big Trades needs a 1-tick chart (one bar = one trade). This chart: ${this.mode.desc}`;
        // Right-aligned to the last bar by shifting the point left by the
        // estimated text width (same technique as Prey).
        const x = op(du(typeof d.index === "function" ? d.index() : 0), "-", px(textWidth(txt, fs) + 8));
        return { graphics: { items: [{
            tag: "Container", key: "bt_live", global: true, children: [{
                tag: "Text", key: "bt_warn",
                point: { x, y: op(du(d.high()), "-", px(30)) },
                text: txt,
                style: { fontSize: fs, fill: WARN_COLOR },
                textAlignment: "rightMiddle",
            }],
        }] } };
    }

    // ---------------- debug ----------------

    debugStatus() {
        if (!this.props.debug) return;
        const now = Date.now();
        if (now - this.debugAt < DEBUG_EVERY_MS) return;
        this.debugAt = now;

        const c = this.cfg, st = this.stats;
        const n = st.count(), m = st.mean(), sd = st.stddev();
        let threshold;
        if (!c.auto) threshold = `${c.minSize} (manual)`;
        else if (n < MIN_STATS_COUNT || !(sd > 0)) threshold = `warming up ${n}/${MIN_STATS_COUNT}`;
        else threshold = (m + c.multiplier * sd).toFixed(1);

        console.log(`[BigTrades] chart=${this.mode.desc} prints=${this.prints} ` +
                    `statsN=${n}/${st.capacity()} mean=${m.toFixed(2)} sd=${sd.toFixed(2)} ` +
                    `threshold=${threshold} bigTrades=${this.hitSerial}`);
    }
}

// ---------------- module exports ----------------

module.exports = {
    name:        "BigTrades",
    description: "Big Trades - size-scaled bubbles for large prints (1-tick chart)",
    calculator:  BigTrades,

    inputType:  meta.InputType.BARS,
    areaChoice: meta.AreaChoice.OVERLAY,

    params: {
        // Filter
        filterMode:     predef.paramSpecs.enum({ auto: "Automatic", manual: "Manual" }, "auto"),
        minTradeSize:   num(100, 1, 1, 1000000),     // Manual mode only
        intensity:      predef.paramSpecs.enum({
                            low:    "Low (1.5 SD)",
                            medium: "Medium (2.5 SD)",
                            strong: "Strong (4.0 SD)",
                        }, "medium"),                 // Automatic mode only
        statsWindow:    num(2000, 50, 50, 50000),     // trades in the rolling population
        classifyMethod: predef.paramSpecs.enum({
                            feed:     "Feed (Bid/Offer Volume)",
                            tickRule: "Tick Rule",
                        }, "feed"),
        aggregateSweeps: predef.paramSpecs.bool(true), // fold same-ms, same-side prints

        // Bubble size
        minBubblePx:    num(8, 1, 2, 100),
        maxBubblePx:    num(36, 1, 4, 200),
        sdScale:        num(3.0, 0.1, 0.5, 20),       // z-score at max bubble size

        // Display
        buyColor:       predef.paramSpecs.color("#28C76F"),
        sellColor:      predef.paramSpecs.color("#E53935"),
        showLabel:      predef.paramSpecs.bool(true),
        labelColor:     predef.paramSpecs.color("#FFFFFF"),
        labelFontSize:  num(11, 1, 6, 30),

        // Diagnostics
        requireOneTickChart: predef.paramSpecs.bool(true),
        debug:          predef.paramSpecs.bool(false),
    },

    plots: {},
    tags: [predef.tags.Volumes],
};