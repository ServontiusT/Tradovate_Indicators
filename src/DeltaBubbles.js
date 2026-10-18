// ============================================================
//  Delta Bubbles — Tradovate Custom Indicator
// ------------------------------------------------------------
//  Plots extreme volume delta as filled, size-scaled bubbles at the price
//  and bar where it built up, colored by side (net buying vs net selling)
//  and labeled with the delta when the label fits inside the bubble.
//
//  HOW IT DIFFERS FROM BIG TRADES
//  Big Trades needs a 1-tick chart, because a bar's volume is not a trade
//  size and indicators can't reach the raw tick stream. This one asks a
//  different question that bars CAN answer: each bar carries volume at
//  price (d.profile() -> { price, vol, bidVol, askVol }), so for every price
//  row inside a bar we know delta = askVol - bidVol. A row whose |delta| is
//  far outside the recent population gets a bubble. Works on any chart type
//  and timeframe.
//
//  A bubble is therefore NOT one trade: it is the net aggression at that
//  price over the life of the bar (one 500-lot or five hundred 1-lots look
//  the same).
//
//  Install: Code Explorer -> File -> New, paste, save, add to a chart.
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

// Automatic threshold: mean + multiplier x stddev of |row delta|
const INTENSITY_SD = { low: 1.5, medium: 2.5, strong: 4.0 };

// OPACITY IS A PERCENT (0-100)
const OP_FILL   = 75;
const OP_BORDER = 90;

const CHAR_W = 0.55;            // approx glyph width as a fraction of font size
const MIN_LABEL_FONT = 7;
const LABEL_FONT_FRACTION = 0.42;

const DEBUG_EVERY_MS = 2000;    // console status line at most this often
const WARN_COLOR = "#EF6C00";
const WARN_AFTER_BARS = 50;     // bars without any volume at price before warning
const MAX_REMEMBERED_BARS = 5000;  // bars whose bubbles are kept for re-emission

// ---------------- small helpers ----------------

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, Number.isFinite(v) ? v : lo));
}

// Number param with an upper bound (predef.paramSpecs.number has no max).
function num(def, step, min, max) {
    return { type: "number", def, restrictions: { step, min, max } };
}

function isLastBar(d, i, history) {
    if (typeof d.isLast === "function") return d.isLast();
    return !!history && typeof history.size === "function" && i === history.size() - 1;
}

function textWidth(txt, fs) {
    return Math.ceil(fs * CHAR_W * txt.length);
}

// ---------------- rolling |delta| statistics ----------------

/**
 * Fixed-capacity circular buffer with O(1) mean/stddev (same as Big Trades).
 * Feeds both the Automatic threshold and z-score bubble sizing.
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

// ---------------- calculator ----------------

class DeltaBubbles {
    // init() and map() never throw: a failure is kept and drawn on the chart
    // (and logged), so a runtime error can't make the indicator vanish silently.
    init() {
        this.error = null;
        try { this.setup(); } catch (e) { this.fail(e); }
    }

    map(d, i, history) {
        if (!this.error) {
            try { return this.run(d, i, history); } catch (e) { this.fail(e); }
        }
        try {
            if (!isLastBar(d, i, history)) return {};
            const x = typeof d.index === "function" ? d.index() : i;
            return this.warning(d, x, `Delta Bubbles error: ${this.error}`);
        } catch (_) { return {}; }
    }

    fail(e) {
        this.error = (e && e.message) || String(e);
        console.log(`[DeltaBubbles] ERROR ${this.error}\n${(e && e.stack) || ""}`);
    }

    setup() {
        const p = this.props;
        this.cfg = {
            auto:       p.filterMode !== "manual",
            minDelta:   Math.max(1, Number(p.minDelta) || 100),
            multiplier: INTENSITY_SD[p.intensity] || INTENSITY_SD.medium,
            sdScale:    Math.max(0.1, Number(p.sdScale) || 3),
            ticksPerRow: clamp(Math.round(p.ticksPerRow), 1, 400),
            minPx:      clamp(Math.round(p.minBubblePx), 2, 100),
            maxPx:      0,
            buyColor:   p.buyColor,
            sellColor:  p.sellColor,
            showLabel:  !!p.showLabel,
            labelColor: p.labelColor,
            labelFontSize: clamp(Math.round(p.labelFontSize), 6, 30),
        };
        this.cfg.maxPx = Math.max(this.cfg.minPx, clamp(Math.round(p.maxBubblePx), 4, 200));

        this.stats = new RollingStats(clamp(Math.round(p.statsWindow), 50, 50000));

        this.held      = null;   // newest bar's rows: drawn, not yet in the population
        this.lastIndex = -1;
        this.remembered = new Map();   // bar index -> its bubbles

        this.bars     = 0;
        this.rowsSeen = 0;
        this.hitCount = 0;
        this.debugAt  = 0;
    }

    run(d, i, history) {
        if (i < this.lastIndex) {
            // Re-call for a closed bar: never count it twice, just hand back
            // whatever it owned.
            const items = this.remembered.get(i);
            return items ? { graphics: { items } } : {};
        }
        if (i > this.lastIndex) {
            // A later bar exists, so the held one is closed: its rows join
            // the population exactly once.
            this.lastIndex = i;
            if (this.held) this.commit(this.held);
        }
        // New newest bar, or a refresh of it. It is judged against the
        // population as it stood BEFORE the bar, so a developing bar can
        // never inflate its own threshold.
        this.held = this.readRows(d);

        const x = typeof d.index === "function" ? d.index() : i;   // chart x must come from d.index()
        const items = this.scan(this.held).map(h => this.bubble(x, h));
        this.remember(i, items);

        if (isLastBar(d, i, history)) {
            this.debugStatus();
            if (this.rowsSeen === 0 && this.held.length === 0 && this.bars >= WARN_AFTER_BARS) {
                return this.warning(d, x,
                    "Delta Bubbles: this chart is not supplying volume at price (bid/ask) data");
            }
        }
        return items.length ? { graphics: { items } } : {};
    }

    // ---------------- pipeline ----------------

    // One bar -> its price rows as { price, delta }, merged to Ticks Per Row.
    readRows(d) {
        const levels = (typeof d.profile === "function" && d.profile()) || [];
        const tick = this.contractInfo && this.contractInfo.tickSize;
        const n = tick > 0 ? this.cfg.ticksPerRow : 1;

        const rows = new Map();
        for (const lv of levels) {
            if (!(lv.price > 0) || !(lv.vol > 0)) continue;
            const delta = (lv.askVol || 0) - (lv.bidVol || 0);
            // Without a tick size rows can't be merged: key on the price itself.
            const bin = tick > 0 ? Math.floor(Math.floor(lv.price / tick + 0.5) / n) : lv.price;
            const row = rows.get(bin);
            if (row) row.delta += delta;
            else rows.set(bin, {
                bin,
                price: tick > 0 ? (bin * n + (n - 1) / 2) * tick : lv.price,   // row center
                delta,
            });
        }
        return [...rows.values()];
    }

    commit(rows) {
        this.bars++;
        this.rowsSeen += rows.length;
        for (const r of rows) this.stats.add(Math.abs(r.delta));
    }

    // Rows of one bar whose |delta| is extreme against the current population.
    scan(rows) {
        const c = this.cfg, st = this.stats;
        const haveStats = st.count() >= MIN_STATS_COUNT;
        const mean = haveStats ? st.mean()   : 0;
        const sd   = haveStats ? st.stddev() : 0;

        const hits = [];
        for (const r of rows) {
            const mag = Math.abs(r.delta);
            const extreme = c.auto
                ? haveStats && sd > 0 && mag >= mean + c.multiplier * sd
                : mag >= c.minDelta;
            if (!extreme || mag === 0) continue;

            const z = sd > 0 ? Math.max(0, (mag - mean) / sd) : 0;
            const frac = Math.max(0, Math.min(1, z / c.sdScale));
            const dia = Math.round(c.minPx + (c.maxPx - c.minPx) * frac);
            hits.push({ bin: r.bin, price: r.price, delta: r.delta, dia });
        }
        return hits;
    }

    remember(i, items) {
        // A refresh of the newest bar replaces what it owned before.
        const old = this.remembered.get(i);
        this.hitCount += items.length - (old ? old.length : 0);
        if (!items.length) { this.remembered.delete(i); return; }
        this.remembered.set(i, items);
        if (this.remembered.size > MAX_REMEMBERED_BARS) {
            this.remembered.delete(this.remembered.keys().next().value);
        }
    }

    // ---------------- drawing ----------------

    // Filled circle + 1px border, label centered inside only when it fits.
    // Radius is in pixels, so bubbles keep their size through zoom.
    bubble(x, h) {
        const c = this.cfg;
        const key = `db_${x}_${h.bin}`;
        const color = h.delta > 0 ? c.buyColor : c.sellColor;
        const circle = [{ tag: "Circle", center: { x: du(x), y: du(h.price) }, radius: h.dia / 2 }];
        const children = [
            { tag: "Shapes", key: `${key}_f`, primitives: circle,
              fillStyle: { color, opacity: OP_FILL } },
            { tag: "ContourShapes", key: `${key}_e`, primitives: circle,
              lineStyle: { lineWidth: 1, color, opacity: OP_BORDER } },
        ];
        if (c.showLabel) {
            const label = this.bubbleLabel(x, h, `${key}_t`);
            if (label) children.push(label);
        }
        return { tag: "Container", key, children };
    }

    bubbleLabel(x, h, key) {
        const c = this.cfg;
        // Side is carried by the color, so the label is the magnitude only.
        const txt = String(Math.round(Math.abs(h.delta)));
        // Shrink the font to fit small bubbles rather than spilling out.
        const fs = Math.floor(Math.max(MIN_LABEL_FONT, Math.min(c.labelFontSize, h.dia * LABEL_FONT_FRACTION)));
        if (textWidth(txt, fs) > h.dia - 2 || fs > h.dia) return null;
        return {
            tag: "Text", key,
            point: { x: du(x), y: du(h.price) },
            text: txt,
            style: { fontSize: fs, fill: c.labelColor },
            textAlignment: "centerMiddle",
        };
    }

    warning(d, x, txt) {
        const fs = 12;
        // Right-aligned to the last bar by shifting the point left by the
        // estimated text width.
        return { graphics: { items: [{
            tag: "Text", key: "db_warn",
            point: { x: op(du(x), "-", px(textWidth(txt, fs) + 8)), y: op(du(d.high()), "-", px(30)) },
            text: txt,
            style: { fontSize: fs, fill: WARN_COLOR },
            textAlignment: "rightMiddle",
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
        if (!c.auto) threshold = `${c.minDelta} (manual)`;
        else if (n < MIN_STATS_COUNT || !(sd > 0)) threshold = `warming up ${n}/${MIN_STATS_COUNT}`;
        else threshold = (m + c.multiplier * sd).toFixed(1);

        console.log(`[DeltaBubbles] bars=${this.bars} rows=${this.rowsSeen} ` +
                    `statsN=${n}/${st.capacity()} mean|delta|=${m.toFixed(2)} sd=${sd.toFixed(2)} ` +
                    `threshold=${threshold} bubbles=${this.hitCount}`);
    }
}

// ---------------- module exports ----------------

module.exports = {
    name:        "DeltaBubbles",
    description: "Delta Bubbles - size-scaled bubbles for extreme delta at price (any chart)",
    calculator:  DeltaBubbles,

    inputType:  meta.InputType.BARS,
    areaChoice: meta.AreaChoice.OVERLAY,

    // Enables d.profile() — required for per-bar volume-at-price data.
    requirements: { volumeProfiles: true },

    params: {
        // Filter
        filterMode:     predef.paramSpecs.enum({ auto: "Automatic", manual: "Manual" }, "auto"),
        minDelta:       num(100, 1, 1, 1000000),      // Manual mode only: |delta| of a row
        intensity:      predef.paramSpecs.enum({
                            low:    "Low (1.5 SD)",
                            medium: "Medium (2.5 SD)",
                            strong: "Strong (4.0 SD)",
                        }, "medium"),                 // Automatic mode only
        statsWindow:    num(2000, 50, 50, 50000),     // price rows in the rolling population
        ticksPerRow:    num(1, 1, 1, 400),            // merge this many ticks into one row

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
        debug:          predef.paramSpecs.bool(false),
    },

    plots: {},
    tags: [predef.tags.Volumes],
};
