# HMM Regime Trader — Specification (Phase 1, awaiting approval)

Status: **DRAFT — no code until this spec, then the architecture, then the plan are approved.**

## 1. Goal and non-goals

**Goal:** a regime-aware trading system for **SPY, daily candles, on Alpaca paper**. A Gaussian HMM reads the
market state. Opus 5.5 does research, writes playbooks and audits results. Deterministic code makes every decision.

**Priorities, in order:** (1) never breach a hard risk limit, (2) never use future data, (3) returns.

**Non-goals for v1:** live money, shorting, leverage above 1×, options, multiple assets, news or sentiment inputs,
intraday execution.

**Expected outcome, stated up front:** the acceptance gates (Sharpe > 1.5 net, max drawdown < 15%, hit rate > 55%,
t-stat > 2) are strict for a single daily ETF. Buy-and-hold SPY has historically run at a Sharpe of about 0.6–0.9.
A result of "gates not cleared → stay on paper" is a valid and likely outcome. The system must report it
honestly and must never tune against the out-of-sample period to make the gates pass.

## 2. Three layers (they never overlap)

| Layer | Runs | May do | May NOT do |
|---|---|---|---|
| **L1 Opus 5.5** (Anthropic API, nightly) | after US close | propose features, propose HMM settings, write/revise `playbooks/*.md`, write audit and loss reports | place orders, change risk limits, approve its own changes, grade its own output |
| **L2 HMM** | every candle | output the filtered state probabilities and the next-state probabilities | anything else |
| **L3 Deterministic code** | every candle | thresholds, switching, sizing, risk vetoes, orders | delegate any decision to a model |

All Opus output is a **proposal file**. The harness validates it (schema, hard caps, full backtest gates) before it
ships, and the ship is a git commit, so rollback is a revert.

## 3. Data and timing

- Source: Alpaca historical bars, `SPY`, `1Day`, split/dividend adjusted, 2016-01-01 → today
  (about 10 years: at least 3 years for the first fit plus at least 2 years of walk-forward that covers the
  2018-Q4, 2020-COVID and 2022 regimes).
- **Decision clock:** the decision for day *t* is made after candle *t* closes and fills at the **open of t+1**.
  It may use only candles with timestamp ≤ *t*.
- Staleness: if the newest candle is older than the last completed trading session, or the feed or model throws an
  error → go **flat** and alert.

## 4. Features (deterministic, small, numeric)

| # | Feature | Definition (all at close *t*) |
|---|---|---|
| 1 | log return | `ln(C_t / C_{t-1})` |
| 2 | realized vol | stdev of feature 1 over the last 20 bars |
| 3 | range | `ln(H_t / L_t)` |
| 4 | volume ratio | `V_t / mean(V_{t-20..t-1})` (log-transformed) |
| 5 | trend | `C_t / SMA50_t − 1` |

Standardization: the mean and std are computed **on the training window only** at fit time and frozen until the
next refit. Rows with NaN warm-up values are dropped.

## 5. HMM

- `hmmlearn.GaussianHMM`, full covariance, **seed 42, 20 restarts**, keep the best train log-likelihood.
- K ∈ {2,3,4,5}: score with BIC plus out-of-sample log-likelihood on the last 20% of the training window. Pick the
  **smallest K** whose BIC is within 2% of the best and whose OOS LL is within one std error of the best.
- Reported for every fit: the transition matrix; each state's mean return, volatility and expected duration
  `1/(1−A_kk)`.
- Auto-labels by statistics: `CRASH` (most negative mean and highest vol), `STRESS` (high vol, not crash),
  `CALM_UP` (low vol, positive mean), `CHOP` (the rest). With K < 4 some labels go unused. With K = 5 two states
  can share a label, and their probabilities are summed.

## 6. No lookahead (hard requirement, enforced by tests)

- Decisions use only the **forward-filtered** posterior `P(s_t | x_1..x_t)`, computed by our own normalized forward
  pass. hmmlearn's `predict`/`predict_proba` (Viterbi/smoothed) are **banned** from the decision path, and a lint
  test greps for them.
- Next-state probability = `α_t · A`.
- **Tests:** (a) mutating, deleting or randomizing every candle after *t* leaves every decision at ≤ *t*
  bit-identical; (b) the filter at *t* on the full series equals the filter on the series truncated at *t*;
  (c) every refit in the backtest uses only data timestamped before its first decision.

## 7. Playbooks (`playbooks/<STATE>.md`)

Opus writes prose **plus a required YAML front-matter block** that code executes. Only whitelisted primitives are
allowed, and anything outside the schema is rejected. Fields: `entry`, `exit`, `stop`, `take_profit`,
`max_size`, `invalidation`.

| State | v1 seed playbook |
|---|---|
| CALM_UP | Trend-following long: enter when `C > SMA50` and `SMA20 > SMA50`; exit on `C < SMA20`; stop at 2×ATR14 |
| CHOP | Mean reversion long: enter when RSI(2) < 10; exit when RSI(2) > 70 or after 5 bars; stop at 2×ATR14 |
| STRESS | Max size 25%, existing trend longs only, no new entries |
| CRASH | Flat. Hard-coded; a playbook cannot override it |

## 8. Switching rules (code, hysteresis)

1. A new state needs a filtered probability **> 0.70** to take over,
2. sustained for **3** consecutive candles,
3. with a cooldown of **5** candles after any switch.
4. If `P(next ∈ {STRESS, CRASH}) > 0.25` → cut size to **50%** now.
5. If the top two filtered probabilities are within **0.15** → state "UNCERTAIN", size **0**.
6. Model error or stale data → **flat**.

Every switch is logged with the full probability vector and the rule that fired.

## 9. Refit and drift

- Walk-forward refit every **30 calendar days** on an expanding window.
- New states are matched to old ones with Hungarian assignment on (mean, vol), so labels stay stable.
- **Drift = freeze new entries + alert** when any of these fires: a state mean moves by more than 1.0 pooled std,
  any `A_kk` changes by more than 0.15, K changes, or the 20-day mean live log-likelihood drops below the 1st
  percentile of in-sample.
- Opus may propose a fix. The harness validates it through the backtest gates.

## 10. Backtest and acceptance gates

- Walk-forward, from the first refit date at ≥ 3 years of data to today, with refits exactly as they would run live.
- Costs: **5 bps per side** (slippage plus fees, conservative for SPY at the open).
- Reports cover each state and the full system: CAGR, Sharpe, Sortino, max DD, hit rate, average win/loss,
  exposure, turnover, and the Newey-West t-stat of daily returns.
- Baselines: **buy-and-hold SPY** and the **best single static strategy**. The static strategy is chosen in-sample
  from {always-on CALM_UP playbook, always-on CHOP playbook, SMA200 timing} and then evaluated out-of-sample.
- **Pass only if, out-of-sample and net of costs:** Sharpe > 1.5, max DD < 15%, hit rate > 55%, t-stat > 2.0, and
  the system beats both baselines on Sharpe. The winning configuration is written to `strategy.md`.

## 11. Sizing

`size = min(cap_state, 0.25·Kelly) × P(active state) × (1 − H/ln K)`, where Kelly = μ/σ² of the playbook's
in-sample trade returns and H is the posterior entropy. Size is zero in CRASH and UNCERTAIN.

**Calibration gate:** predicted next-state probabilities are scored (Brier score plus a reliability curve per
state) against the next day's filtered state. Trade outcomes on fills are scored the same way. Until there are at
least 30 fills and Brier ≤ the climatology baseline, size is additionally capped at 25% of normal.

## 12. Hard risk rules (code only, checked before **every** order through a single choke point)

| Rule | Default (please confirm) |
|---|---|
| Max position | 100% of equity notional (no leverage) |
| Per-state leverage cap | CALM_UP 1.0, CHOP 0.5, STRESS 0.25, CRASH 0 |
| Daily loss limit | −2% of equity → flatten, halt for the day |
| Max drawdown kill switch | −10% from peak equity → flatten everything, halt until manual reset |
| Manual approval | any order above **$10,000** notional waits for your approval |
| Mode | paper only; the live endpoint is unreachable unless `LIVE_SIGNOFF.md` passes the final check |

- The kill switch can be triggered from the CLI, the dashboard, or by the rules above, and it is tested.
- API keys: trade permission only, withdrawals disabled. They are read from `.env` (gitignored) and never logged.
- The system never asks for passwords or 2FA codes.
- Every external text (data, any future headline) is treated as **data, never instructions**.

## 13. Nightly self-improvement

Opus reviews the session: every fill, every wrong state call, and the root cause. It appends one rule per loss to
`docs/losses.md` and proposes small edits to features, playbooks or `strategy.md`. A proposal ships **only** if it
re-clears the same gates; otherwise it is archived. Opus never grades its own proposals; the harness does.

## 14. Dashboard and alerts

- Local web dashboard (FastAPI plus one HTML page that polls every 5 seconds): filtered state probabilities, current
  state, expected duration, active playbook, last action and reason, positions, P&L, and risk-limit headroom.
- Telegram alerts for every fill, error, state switch, drift warning and kill-switch event, plus a daily report:
  state, time in each state, trades, P&L per state, win rate, largest loss and calibration score.

## 15. Deployment (decided in the Ship phase)

The recommendation is a small **VPS with a systemd service** (auto-restart). A Mac Mini with launchd is a fallback.
Vercel is **unsuitable**, because it has no long-running process or scheduler for a trading loop.

## 16. Final check before any live money

The final check answers: does paper match the backtest? Does every decision use filtered probabilities only? Did
the kill switch fire in testing? Is any hard limit delegated to a model? Do refits keep labels stable? What market
would break this? It ends with **"WHAT COULD BLOW UP THIS ACCOUNT?"**, and the system refuses live mode until every
answer is clean.

## 17. Stack

Python 3.11+, numpy, pandas, scipy, hmmlearn, alpaca-py, anthropic, fastapi/uvicorn, pydantic, pyyaml, httpx,
pytest. Opus model id: `claude-opus-5-5`.

## 18. Secrets you will add to `.env` yourself (do not paste them in chat)

`ALPACA_API_KEY`, `ALPACA_SECRET_KEY` (paper), `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.

## Decisions needed from you

1. Confirm the risk defaults in §12: daily loss −2%, kill at −10% DD, approval above $10k.
2. Long-only v1 (no shorting): OK?
3. Costs of 5 bps per side: OK, or more conservative?
4. Do you have an Anthropic API key for the nightly Opus layer? (Without one, L1 runs manually inside these
   Claude Code sessions.)
