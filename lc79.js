/**
 * =====================================================================
 * 🚀 UNLTRA PRO V7.0 – TÍCH HỢP QUANT ENGINE V22 OMEGA
 * =====================================================================
 * - Thay thế toàn bộ 105 mô hình cũ bằng QuantEngineV22Omega
 * - Giữ nguyên cấu trúc API, fetch, cache, lưu lịch sử
 * - Tối ưu hiệu suất với engine V22
 * =====================================================================
 */

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ---------- CẤU HÌNH ----------
const API_HU = 'https://wtx.tele68.com/v1/tx/sessions';
const API_MD5 = 'https://wtxmd52.tele68.com/v1/txmd5/sessions';
const TIMEOUT = 20000;
const RETRY_COUNT = 3;
const MAX_HISTORY = 300;

const HISTORY_HU_FILE = path.join(__dirname, 'history_hu.json');
const HISTORY_MD5_FILE = path.join(__dirname, 'history_md5.json');
const ENGINE_STATE_FILE = path.join(__dirname, 'engine_state.json');

let cacheHu = null, cacheMd5 = null;
let cacheHuTime = 0, cacheMd5Time = 0;

// ---------- QUANT ENGINE V22 OMEGA (nhúng trực tiếp) ----------
// [CODE CỦA QUANT ENGINE V22 OMEGA ĐƯỢC CHÈN VÀO ĐÂY]
// (Tất cả các hàm utility, class QuantEngineV22Omega, và global bridge)

// ==================== UTILITY FUNCTIONS ====================
function factorial(n) {
    if (n < 0) return 0;
    if (n <= 1) return 1;
    let res = 1;
    for (let i = 2; i <= n; i++) res *= i;
    return res;
}

function combination(n, k) {
    if (k < 0 || k > n) return 0;
    if (k === 0 || k === n) return 1;
    k = Math.min(k, n - k);
    let res = 1;
    for (let i = 1; i <= k; i++) {
        res *= (n - k + i) / i;
    }
    return Math.round(res);
}

function shannonEntropy(seq) {
    const counts = { T: 0, X: 0 };
    for (let s of seq) counts[s]++;
    const total = seq.length;
    if (total === 0) return 0;
    let entropy = 0;
    for (let key of ['T', 'X']) {
        const p = counts[key] / total;
        if (p > 0) entropy -= p * Math.log2(p);
    }
    return entropy;
}

function conditionalEntropy(transitionCounts) {
    let totalTransitions = 0;
    let condEntropy = 0;
    for (let state in transitionCounts) {
        const nextCounts = transitionCounts[state];
        const stateTotal = nextCounts.T + nextCounts.X;
        if (stateTotal === 0) continue;
        totalTransitions += stateTotal;
        let stateEntropy = 0;
        for (let outcome of ['T', 'X']) {
            const p = nextCounts[outcome] / stateTotal;
            if (p > 0) stateEntropy -= p * Math.log2(p);
        }
        condEntropy += stateEntropy * stateTotal;
    }
    return totalTransitions > 0 ? condEntropy / totalTransitions : 0;
}

function wilsonCI(successes, trials, z = 1.96) {
    if (trials === 0) return { lower: 0, upper: 1 };
    const p = successes / trials;
    const denominator = 1 + z * z / trials;
    const center = (p + z * z / (2 * trials)) / denominator;
    const margin = z * Math.sqrt((p * (1 - p) + z * z / (4 * trials)) / trials) / denominator;
    return {
        lower: Math.max(0, center - margin),
        upper: Math.min(1, center + margin)
    };
}

function detectChangePoint(sequence, threshold = 2.5) {
    if (sequence.length < 20) return false;
    const mean = sequence.reduce((a, b) => a + b, 0) / sequence.length;
    let cusum = 0;
    for (let i = 0; i < sequence.length; i++) {
        cusum += sequence[i] - mean;
        if (Math.abs(cusum) > threshold * Math.sqrt(sequence.length)) {
            return true;
        }
    }
    return false;
}

function plattScale(logit, A = 1.0, B = 0.0) {
    return 1 / (1 + Math.exp(-(A * logit + B)));
}

// ==================== QUANT ENGINE V22 OMEGA CLASS ====================
class QuantEngineV22Omega {
    // Private fields
    #history;
    #enginePerformance;
    #patternMemory;
    #markovChain;
    #markovOrderChains;
    #patternCache;
    #sessionCount;
    #weights;
    #weightsRecent;
    #learningRate = 0.05;
    #lastPredictions;
    #lastMetaScore;
    #bootstrapCache;
    
    // Neural Network fields (LSTM-like)
    #rnnWeights;
    #rnnHiddenState;
    #rnnMomentum;
    
    // Logistic Regression fields
    #logisticWeights;
    #logisticMomentum;
    
    // Meta Stacking fields
    #metaWeights;
    #metaMomentum;
    
    // Platt Scaling parameters
    #plattA = 1.0;
    #plattB = 0.0;
    
    // Attention weights
    #attentionWeights;
    
    // Change point detection
    #changePointHistory = [];
    #lastChangePoint = 0;

    constructor(history = []) {
        this.#history = [...history];
        this.#sessionCount = 0;
        this.#patternCache = new Map();
        this.#patternMemory = {};
        this.#markovChain = {};
        this.#markovOrderChains = { 1: null, 2: null, 3: null };
        this.#weights = {};
        this.#weightsRecent = {};
        this.#lastPredictions = {};
        this.#lastMetaScore = 0;
        this.#bootstrapCache = null;
        
        // Khởi tạo RNN
        this.#rnnWeights = {
            Wih: Array.from({ length: 8 }, () => Array.from({ length: 2 }, () => Math.random() * 0.1 - 0.05)),
            Whh: Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => Math.random() * 0.1 - 0.05)),
            b_h: Array.from({ length: 8 }, () => Math.random() * 0.1 - 0.05),
            Who: Array.from({ length: 2 }, () => Array.from({ length: 8 }, () => Math.random() * 0.1 - 0.05)),
            b_o: Array.from({ length: 2 }, () => Math.random() * 0.1 - 0.05)
        };
        this.#rnnHiddenState = Array(8).fill(0);
        this.#rnnMomentum = {
            Wih: Array.from({ length: 8 }, () => Array(2).fill(0)),
            Whh: Array.from({ length: 8 }, () => Array(8).fill(0)),
            b_h: Array(8).fill(0),
            Who: Array.from({ length: 2 }, () => Array(8).fill(0)),
            b_o: Array(2).fill(0)
        };
        
        // Logistic Regression
        this.#logisticWeights = { w: [Math.random() * 0.1, Math.random() * 0.1], b: Math.random() * 0.1 };
        this.#logisticMomentum = { w: [0, 0], b: 0 };
        
        // Meta Stacking
        this.#metaWeights = { 
            w: Array.from({ length: 14 }, () => Math.random() * 0.1 - 0.05),
            b: Math.random() * 0.1
        };
        this.#metaMomentum = { w: Array(14).fill(0), b: 0 };
        
        // Attention
        this.#attentionWeights = Array(50).fill(1/50);
        
        // Khởi tạo performance
        const engineNames = [
            'pattern', 'probability', 'bayesian', 'markov', 'montecarlo',
            'momentum', 'state', 'risk', 'dice', 'balance', 'signalscoring',
            'adaptiveweight', 'noisefilter', 'patternlearning', 'reinforcement',
            'bootstrap1000', 'rnn', 'logistic', 'metastack'
        ];
        this.#enginePerformance = {};
        for (let name of engineNames) {
            this.#enginePerformance[name] = {
                correct: 0, total: 0, accuracy: 0.5, winrate: 0.5,
                drawdown: 0, maxDrawdown: 0, stability: 1.0, varianceAcc: 0,
                accHistory: [], recentCorrect: 0, recentTotal: 0
            };
        }

        this.#buildMarkovChains();
        this.#updateDynamicWeights();
    }

    // ==================== CORE: BUILD MARKOV CHAINS ====================
    #buildMarkovChains() {
        const h = this.#history;
        const chain = {
            'TT': { T: 0, X: 0, total: 0 },
            'TX': { T: 0, X: 0, total: 0 },
            'XT': { T: 0, X: 0, total: 0 },
            'XX': { T: 0, X: 0, total: 0 }
        };
        for (let i = 2; i < h.length; i++) {
            const state = h[i - 2] + h[i - 1];
            const next = h[i];
            if (chain[state]) {
                chain[state][next]++;
                chain[state].total++;
            }
        }
        this.#markovChain = chain;

        const chain2 = {};
        const chain3 = {};
        for (let i = 3; i < h.length; i++) {
            const s2 = h[i - 3] + h[i - 2] + h[i - 1];
            if (!chain2[s2]) chain2[s2] = { T: 0, X: 0, total: 0 };
            chain2[s2][h[i]]++;
            chain2[s2].total++;
            
            if (i >= 4) {
                const s3 = h[i - 4] + h[i - 3] + h[i - 2] + h[i - 1];
                if (!chain3[s3]) chain3[s3] = { T: 0, X: 0, total: 0 };
                chain3[s3][h[i]]++;
                chain3[s3].total++;
            }
        }
        this.#markovOrderChains[1] = chain;
        this.#markovOrderChains[2] = chain2;
        this.#markovOrderChains[3] = chain3;

        this.#bootstrapCache = null;
        this.#patternCache.clear();
        this.#detectChangePoint();
    }

    // ==================== CHANGE POINT DETECTION ====================
    #detectChangePoint() {
        const h = this.#history;
        if (h.length < 20) return;
        const seq = h.slice(-100).map(x => x === 'T' ? 1 : 0);
        if (detectChangePoint(seq, 2.0)) {
            this.#lastChangePoint = this.#history.length;
            this.#rnnHiddenState = Array(8).fill(0);
            this.#rnnMomentum = {
                Wih: Array.from({ length: 8 }, () => Array(2).fill(0)),
                Whh: Array.from({ length: 8 }, () => Array(8).fill(0)),
                b_h: Array(8).fill(0),
                Who: Array.from({ length: 2 }, () => Array(8).fill(0)),
                b_o: Array(2).fill(0)
            };
        }
    }

    // ==================== ATTENTION MECHANISM ====================
    #computeAttention() {
        const h = this.#history;
        const len = h.length;
        if (len < 10) return Array(50).fill(1/50);
        
        const weights = Array(50).fill(0);
        const alpha = 0.1;
        const currentState = h.slice(-4).join('');
        
        for (let i = 0; i < Math.min(50, len); i++) {
            const idx = len - 1 - i;
            if (idx < 4) break;
            const state = h.slice(idx - 4, idx).join('');
            let similarity = 0;
            for (let j = 0; j < Math.min(4, state.length); j++) {
                if (state[j] === currentState[j]) similarity++;
            }
            similarity /= 4;
            weights[i] = Math.exp(alpha * similarity);
        }
        
        const sum = weights.reduce((a, b) => a + b, 0);
        if (sum > 0) {
            for (let i = 0; i < weights.length; i++) {
                weights[i] /= sum;
            }
        } else {
            for (let i = 0; i < weights.length; i++) weights[i] = 1/50;
        }
        
        this.#attentionWeights = weights;
        return weights;
    }

    // ==================== PUBLIC METHOD: PREDICT ====================
    predict() {
        this.#computeAttention();
        
        const patternRes = this.#computePatternEngine();
        const probRes = this.#computeProbabilityEngine();
        const bayesRes = this.#computeBayesianEngine();
        const markovRes = this.#computeMarkovEngine();
        const monteCarloRes = this.#computeMonteCarloEngine();
        const momentumRes = this.#computeMomentumEngine();
        const stateRes = this.#computeStateEngine();
        const riskRes = this.#computeRiskEngine();
        const diceRes = this.#computeDiceAnalysisEngine();
        const balanceRes = this.#computeBalanceEngine();
        const signalRes = this.#computeSignalScoringEngine();
        const adaptiveRes = this.#computeAdaptiveWeightEngine();
        const noiseRes = this.#computeNoiseFilterEngine();
        const patternLearningRes = this.#computePatternLearningAI();
        const reinforcementRes = this.#computeReinforcementLearningEngine();
        const bootstrap1000Res = this.#computeBootstrap1000Engine();
        const rnnRes = this.#computeRNNEngine();
        const logisticRes = this.#computeLogisticEngine();
        const metaRes = this.#computeMetaStackingEngine();

        const enginePredictions = {
            pattern: patternRes,
            probability: probRes,
            bayesian: bayesRes,
            markov: markovRes,
            montecarlo: monteCarloRes,
            momentum: momentumRes,
            state: stateRes,
            risk: riskRes,
            dice: diceRes,
            balance: balanceRes,
            signalscoring: signalRes,
            adaptiveweight: adaptiveRes,
            noisefilter: noiseRes,
            patternlearning: patternLearningRes,
            reinforcement: reinforcementRes,
            bootstrap1000: bootstrap1000Res,
            rnn: rnnRes,
            logistic: logisticRes,
            metastack: metaRes
        };
        this.#lastPredictions = enginePredictions;

        const metaResult = this.#ensembleMetaModel(enginePredictions);
        const { prediction, metaScore } = metaResult;

        const calibratedProb = plattScale(metaScore, this.#plattA, this.#plattB);
        const antiOverfitConfidence = this.#antiOverfittingLayer(enginePredictions, prediction, metaScore);
        const smartConf = this.#smartConfidence(enginePredictions, prediction, antiOverfitConfidence);
        const entropyResult = this.#computeEntropyIntelligence();

        const report = {
            prediction,
            confidence: smartConf,
            calibratedConfidence: Math.min(1, calibratedProb * 2),
            riskLevel: riskRes.riskLevel,
            entropyLevel: entropyResult.level,
            probability: {
                tai: probRes.probT,
                xiu: probRes.probX
            },
            engines: {
                pattern: patternRes.prediction,
                probability: probRes.prediction,
                bayesian: bayesRes.prediction,
                markov: markovRes.prediction,
                montecarlo: monteCarloRes.prediction,
                momentum: momentumRes.prediction,
                state: stateRes.prediction,
                risk: riskRes.prediction,
                dice: diceRes.prediction,
                bootstrap1000: bootstrap1000Res.prediction,
                rnn: rnnRes.prediction,
                logistic: logisticRes.prediction,
                metastack: metaRes.prediction
            },
            metaScore,
            diagnostics: {
                chaos: entropyResult.level === 'CHAOTIC',
                noise: noiseRes.noiseLevel,
                trapProbability: this.#calculateTrapProbability(),
                reversalRisk: this.#calculateReversalRisk(),
                engineAgreement: this.#calculateEngineAgreement(enginePredictions),
                changePointDetected: this.#lastChangePoint > this.#history.length - 50
            }
        };
        return report;
    }

    // ==================== UPDATE AFTER ACTUAL RESULT ====================
    update(actual) {
        if (!this.#lastPredictions || Object.keys(this.#lastPredictions).length === 0) {
            this.#history.push(actual);
            this.#sessionCount++;
            this.#buildMarkovChains();
            return;
        }

        this.#history.push(actual);
        this.#sessionCount++;
        this.#buildMarkovChains();

        for (const [engineName, pred] of Object.entries(this.#lastPredictions)) {
            if (!pred || !pred.prediction) continue;
            const perf = this.#enginePerformance[engineName];
            if (!perf) continue;

            const correct = pred.prediction === actual ? 1 : 0;
            perf.total++;
            perf.correct += correct;
            const newAccuracy = perf.total > 0 ? perf.correct / perf.total : 0.5;
            perf.accHistory.push(newAccuracy);
            if (perf.accHistory.length > 50) perf.accHistory.shift();
            perf.accuracy = newAccuracy;
            perf.winrate = newAccuracy;
            
            perf.recentTotal = Math.min(20, perf.recentTotal + 1);
            perf.recentCorrect = perf.recentCorrect + correct;
            if (perf.recentTotal > 20) {
                perf.recentCorrect = Math.max(0, perf.recentCorrect - 1);
            }

            if (correct) {
                perf.drawdown = 0;
            } else {
                perf.drawdown++;
                if (perf.drawdown > perf.maxDrawdown) perf.maxDrawdown = perf.drawdown;
            }

            if (perf.accHistory.length > 1) {
                const mean = perf.accHistory.reduce((a, b) => a + b, 0) / perf.accHistory.length;
                const variance = perf.accHistory.reduce((sum, val) => sum + (val - mean) ** 2, 0) / perf.accHistory.length;
                const std = Math.sqrt(variance);
                perf.stability = Math.max(0, 1 - std * 2);
                perf.varianceAcc = variance;
            } else {
                perf.stability = 1.0;
            }
        }

        this.#updatePatternLearningAI(actual);
        this.#trainRNN(actual);
        this.#trainLogistic(actual);
        this.#trainMetaStack(actual);
        this.#updatePlattScaling(actual);
        this.#updateDynamicWeights();

        this.#lastPredictions = {};
    }

    // ==================== ENGINE IMPLEMENTATIONS ====================
    #computePatternEngine() {
        const h = this.#history;
        const len = h.length;
        if (len < 3) return { prediction: 'T', confidence: 0.5, probT: 0.5, probX: 0.5 };
        const recentPattern = h.slice(-3).join('');
        const cacheKey = 'pattern_' + recentPattern;
        if (this.#patternCache.has(cacheKey)) {
            return this.#patternCache.get(cacheKey);
        }
        let countT = 0, countX = 0;
        for (let i = 0; i < len - 3; i++) {
            const sub = h.slice(i, i + 3).join('');
            if (sub === recentPattern && i + 3 < len) {
                const next = h[i + 3];
                if (next === 'T') countT++;
                else countX++;
            }
        }
        const total = countT + countX;
        let probT, probX;
        if (total > 0) {
            probT = countT / total;
            probX = countX / total;
        } else {
            const globalT = h.filter(x => x === 'T').length / len;
            probT = globalT;
            probX = 1 - globalT;
        }
        const prediction = probT >= probX ? 'T' : 'X';
        const confidence = Math.abs(probT - 0.5) * 2;
        const res = { prediction, confidence, probT, probX };
        this.#patternCache.set(cacheKey, res);
        return res;
    }

    #computeProbabilityEngine(windowSize = 50) {
        const h = this.#history.slice(-windowSize);
        const len = h.length;
        if (len === 0) return { prediction: 'T', confidence: 0.5, probT: 0.5, probX: 0.5 };
        const countT = h.filter(x => x === 'T').length;
        const probT = countT / len;
        const probX = 1 - probT;
        const confidence = Math.abs(probT - 0.5) * 2;
        return { prediction: probT > 0.5 ? 'T' : 'X', confidence, probT, probX };
    }

    #computeBayesianEngine() {
        const h = this.#history;
        const countT = h.filter(x => x === 'T').length;
        const total = h.length;
        const alpha = 1 + countT;
        const beta = 1 + (total - countT);
        const probT = alpha / (alpha + beta);
        const probX = beta / (alpha + beta);
        const confidence = Math.min(1, Math.abs(probT - 0.5) * 2);
        return { prediction: probT > 0.5 ? 'T' : 'X', confidence, probT, probX };
    }

    #computeMarkovEngine() {
        const h = this.#history;
        const len = h.length;
        if (len < 2) return { prediction: 'T', confidence: 0.5, probT: 0.5, probX: 0.5 };

        const voteT = { weight: 0, score: 0 };
        const voteX = { weight: 0, score: 0 };

        const state1 = h[len - 2] + h[len - 1];
        if (this.#markovChain[state1] && this.#markovChain[state1].total > 0) {
            const stats = this.#markovChain[state1];
            const probT1 = stats.T / stats.total;
            voteT.score += probT1;
            voteX.score += (1 - probT1);
            voteT.weight += 1;
            voteX.weight += 1;
        }

        if (len >= 3) {
            const state2 = h[len - 3] + h[len - 2] + h[len - 1];
            const chain2 = this.#markovOrderChains[2];
            if (chain2 && chain2[state2] && chain2[state2].total > 0) {
                const stats = chain2[state2];
                const probT2 = stats.T / stats.total;
                voteT.score += probT2 * 1.2;
                voteX.score += (1 - probT2) * 1.2;
                voteT.weight += 1.2;
                voteX.weight += 1.2;
            }
        }

        if (len >= 4) {
            const state3 = h[len - 4] + h[len - 3] + h[len - 2] + h[len - 1];
            const chain3 = this.#markovOrderChains[3];
            if (chain3 && chain3[state3] && chain3[state3].total > 0) {
                const stats = chain3[state3];
                const probT3 = stats.T / stats.total;
                voteT.score += probT3 * 1.5;
                voteX.score += (1 - probT3) * 1.5;
                voteT.weight += 1.5;
                voteX.weight += 1.5;
            }
        }

        const totalScoreT = voteT.score;
        const totalScoreX = voteX.score;
        const sumScore = totalScoreT + totalScoreX;
        let probT, probX;
        if (sumScore > 0) {
            probT = totalScoreT / sumScore;
            probX = totalScoreX / sumScore;
        } else {
            probT = 0.5; probX = 0.5;
        }
        const confidence = Math.min(1, Math.abs(probT - 0.5) * 2);
        return { prediction: probT > 0.5 ? 'T' : 'X', confidence, probT, probX };
    }

    #computeMonteCarloEngine() {
        const h = this.#history;
        if (h.length < 2) return { prediction: 'T', confidence: 0.5, probT: 0.5, probX: 0.5, ciLower: 0, ciUpper: 1 };
        const state = h[h.length - 2] + h[h.length - 1];
        const chain = this.#markovChain;
        if (!chain[state] || chain[state].total === 0) {
            return this.#computeProbabilityEngine();
        }
        const transProbs = {
            T: chain[state].T / chain[state].total,
            X: chain[state].X / chain[state].total
        };
        const numSims = 30000;
        let countT = 0;
        for (let i = 0; i < numSims; i++) {
            if (Math.random() < transProbs.T) countT++;
        }
        const probT = countT / numSims;
        const probX = 1 - probT;
        const confidence = Math.min(1, Math.abs(probT - 0.5) * 2);
        const ci = wilsonCI(countT, numSims);
        return { prediction: probT > 0.5 ? 'T' : 'X', confidence, probT, probX, ciLower: ci.lower, ciUpper: ci.upper };
    }

    #computeMomentumEngine(windowSize = 20) {
        const h = this.#history.slice(-windowSize);
        if (h.length === 0) return { prediction: 'T', confidence: 0.5 };
        const countT = h.filter(x => x === 'T').length;
        const momentum = (countT - (h.length - countT)) / h.length;
        const probT = 0.5 + momentum / 2;
        const probX = 1 - probT;
        const confidence = Math.abs(momentum);
        return { prediction: momentum > 0 ? 'T' : 'X', confidence, probT, probX };
    }

    #computeStateEngine() {
        const h = this.#history;
        const len = h.length;
        if (len < 2) return { prediction: 'T', confidence: 0.5 };
        let streak = 1;
        const last = h[len - 1];
        for (let i = len - 2; i >= 0; i--) {
            if (h[i] === last) streak++;
            else break;
        }
        let prediction, confidence;
        if (streak >= 3) {
            prediction = last === 'T' ? 'X' : 'T';
            confidence = Math.min(0.9, streak * 0.15);
        } else {
            prediction = last;
            confidence = 0.5;
        }
        return { prediction, confidence, probT: prediction === 'T' ? 0.7 : 0.3, probX: prediction === 'X' ? 0.7 : 0.3 };
    }

    #computeBalanceEngine() {
        const h = this.#history;
        const len = h.length;
        if (len < 10) return { prediction: 'T', confidence: 0.5 };
        const countT = h.filter(x => x === 'T').length;
        const diff = countT - (len - countT);
        if (Math.abs(diff) > len * 0.1) {
            const prediction = diff > 0 ? 'X' : 'T';
            const confidence = Math.min(0.8, Math.abs(diff) / len * 2);
            return { prediction, confidence, probT: prediction === 'T' ? 0.7 : 0.3, probX: prediction === 'X' ? 0.7 : 0.3 };
        }
        return this.#computeProbabilityEngine();
    }

    #computeSignalScoringEngine() {
        const pat = this.#computePatternEngine();
        const prob = this.#computeProbabilityEngine();
        const mom = this.#computeMomentumEngine();
        let scoreT = 0, scoreX = 0;
        scoreT += pat.prediction === 'T' ? pat.confidence : 0;
        scoreX += pat.prediction === 'X' ? pat.confidence : 0;
        scoreT += prob.prediction === 'T' ? prob.confidence : 0;
        scoreX += prob.prediction === 'X' ? prob.confidence : 0;
        scoreT += mom.prediction === 'T' ? mom.confidence : 0;
        scoreX += mom.prediction === 'X' ? mom.confidence : 0;
        const total = scoreT + scoreX || 1;
        const probT = scoreT / total;
        const probX = scoreX / total;
        return { prediction: probT > 0.5 ? 'T' : 'X', confidence: Math.abs(probT - 0.5) * 2, probT, probX };
    }

    #computeAdaptiveWeightEngine() {
        const engs = ['pattern', 'probability', 'markov', 'bayesian', 'momentum'];
        let weightedT = 0, weightedX = 0;
        for (let name of engs) {
            const w = this.#weights[name] || 0.2;
            const pred = this.#getEnginePrediction(name);
            if (pred.prediction === 'T') weightedT += w * pred.confidence;
            else weightedX += w * pred.confidence;
        }
        const total = weightedT + weightedX || 1;
        const probT = weightedT / total;
        return { prediction: probT > 0.5 ? 'T' : 'X', confidence: Math.abs(probT - 0.5) * 2, probT, probX: 1 - probT };
    }

    #computeNoiseFilterEngine() {
        const h = this.#history;
        const len = h.length;
        if (len < 10) return { prediction: 'T', noiseLevel: 0.5, confidence: 0.5 };
        let reversals = 0;
        for (let i = 1; i < len; i++) if (h[i] !== h[i - 1]) reversals++;
        const reversalRate = reversals / (len - 1);
        const noiseLevel = reversalRate;
        const confidence = Math.max(0.1, 1 - noiseLevel);
        const probT = h.filter(x => x === 'T').length / len;
        return { prediction: probT > 0.5 ? 'T' : 'X', noiseLevel, confidence, probT, probX: 1 - probT };
    }

    #computeRiskEngine() {
        const h = this.#history;
        const len = h.length;
        if (len < 5) return { prediction: 'T', riskLevel: 'MEDIUM', confidence: 0.5 };
        let changes = 0;
        for (let i = 1; i < len; i++) if (h[i] !== h[i - 1]) changes++;
        const volatility = changes / (len - 1);
        let riskLevel;
        if (volatility < 0.3) riskLevel = 'LOW';
        else if (volatility < 0.6) riskLevel = 'MEDIUM';
        else riskLevel = 'HIGH';
        const last = h[len - 1];
        const prediction = riskLevel === 'HIGH' ? (last === 'T' ? 'X' : 'T') : last;
        return { prediction, riskLevel, confidence: 0.6 };
    }

    #computeDiceAnalysisEngine() {
        const h = this.#history;
        if (h.length < 20) return { prediction: 'T', confidence: 0.5 };
        const countT = h.filter(x => x === 'T').length;
        const total = h.length;
        const pT = countT / total;
        if (Math.abs(pT - 0.5) > 0.05) {
            const prediction = pT > 0.5 ? 'T' : 'X';
            return { prediction, confidence: Math.min(0.9, Math.abs(pT - 0.5) * 10), probT: pT, probX: 1 - pT };
        }
        return this.#computeProbabilityEngine();
    }

    #computeEntropyIntelligence() {
        const h = this.#history;
        const entropy = shannonEntropy(h);
        let level;
        if (entropy < 0.3) level = 'LOW';
        else if (entropy < 0.7) level = 'MEDIUM';
        else if (entropy < 0.95) level = 'HIGH';
        else level = 'CHAOTIC';
        const condEntropy = conditionalEntropy(this.#markovChain);
        const infoGain = entropy - condEntropy;
        return { entropy, level, conditionalEntropy: condEntropy, informationGain: infoGain };
    }

    #computePatternLearningAI() {
        const h = this.#history;
        const len = h.length;
        if (len < 3) return { prediction: 'T', confidence: 0.5 };
        for (let n = Math.min(5, len - 1); n >= 1; n--) {
            const gram = h.slice(-n).join('');
            if (this.#patternMemory[gram] && this.#patternMemory[gram].total >= 3) {
                const mem = this.#patternMemory[gram];
                const probT = mem.T / mem.total;
                const confidence = Math.min(1, mem.successRate);
                return { prediction: probT > 0.5 ? 'T' : 'X', confidence, probT, probX: 1 - probT, pattern: gram, successRate: mem.successRate };
            }
        }
        return this.#computePatternEngine();
    }

    #updatePatternLearningAI(actual) {
        const h = this.#history;
        const len = h.length;
        if (len < 2) return;
        for (let n = 1; n <= Math.min(5, len - 1); n++) {
            const gram = h.slice(len - 1 - n, len - 1).join('');
            if (!this.#patternMemory[gram]) {
                this.#patternMemory[gram] = { T: 0, X: 0, total: 0, successRate: 0.5, lastUsed: Date.now() };
            }
            const mem = this.#patternMemory[gram];
            mem[actual]++;
            mem.total++;
            mem.successRate = Math.max(mem.T, mem.X) / mem.total;
            mem.lastUsed = Date.now();
        }
    }

    #computeReinforcementLearningEngine() {
        return { prediction: null, weights: { ...this.#weights } };
    }

    // ==================== RNN ENGINE ====================
    #computeRNNEngine() {
        const h = this.#history;
        if (h.length < 5) return { prediction: 'T', confidence: 0.5, probT: 0.5, probX: 0.5 };
        
        const recent = h.slice(-20);
        const countT = recent.filter(x => x === 'T').length;
        const probT = countT / recent.length;
        const momentum = this.#computeMomentumEngine().probT || 0.5;
        const input = [probT, momentum];
        
        const { Wih, Whh, b_h, Who, b_o } = this.#rnnWeights;
        let hidden = this.#rnnHiddenState;
        
        const newHidden = Array(8);
        for (let i = 0; i < 8; i++) {
            let sum = b_h[i];
            for (let j = 0; j < 2; j++) sum += Wih[i][j] * input[j];
            for (let j = 0; j < 8; j++) sum += Whh[i][j] * hidden[j];
            newHidden[i] = 1 / (1 + Math.exp(-sum));
        }
        this.#rnnHiddenState = newHidden;
        
        const output = Array(2);
        for (let i = 0; i < 2; i++) {
            let sum = b_o[i];
            for (let j = 0; j < 8; j++) sum += Who[i][j] * newHidden[j];
            output[i] = 1 / (1 + Math.exp(-sum));
        }
        
        const probT_rnn = output[0];
        const probX_rnn = output[1];
        const prediction = probT_rnn > probX_rnn ? 'T' : 'X';
        const confidence = Math.min(1, Math.abs(probT_rnn - 0.5) * 2);
        
        return { prediction, confidence, probT: probT_rnn, probX: probX_rnn };
    }

    #trainRNN(actual) {
        const target = actual === 'T' ? [1, 0] : [0, 1];
        const lr = 0.008;
        const momentum = 0.9;
        
        const { Wih, Whh, b_h, Who, b_o } = this.#rnnWeights;
        const hidden = this.#rnnHiddenState;
        const input = [this.#computeProbabilityEngine().probT, this.#computeMomentumEngine().probT || 0.5];
        const newHidden = Array(8);
        for (let i = 0; i < 8; i++) {
            let sum = b_h[i];
            for (let j = 0; j < 2; j++) sum += Wih[i][j] * input[j];
            for (let j = 0; j < 8; j++) sum += Whh[i][j] * hidden[j];
            newHidden[i] = 1 / (1 + Math.exp(-sum));
        }
        
        const output = Array(2);
        for (let i = 0; i < 2; i++) {
            let sum = b_o[i];
            for (let j = 0; j < 8; j++) sum += Who[i][j] * newHidden[j];
            output[i] = 1 / (1 + Math.exp(-sum));
        }
        
        const d_output = output.map((o, i) => o * (1 - o) * (target[i] - o));
        const d_hidden = Array(8).fill(0);
        for (let i = 0; i < 8; i++) {
            let sum = 0;
            for (let k = 0; k < 2; k++) sum += Who[k][i] * d_output[k];
            d_hidden[i] = newHidden[i] * (1 - newHidden[i]) * sum;
        }
        
        for (let k = 0; k < 2; k++) {
            for (let i = 0; i < 8; i++) {
                const grad = lr * d_output[k] * newHidden[i];
                this.#rnnMomentum.Who[k][i] = momentum * this.#rnnMomentum.Who[k][i] + grad;
                Who[k][i] += this.#rnnMomentum.Who[k][i];
            }
            this.#rnnMomentum.b_o[k] = momentum * this.#rnnMomentum.b_o[k] + lr * d_output[k];
            b_o[k] += this.#rnnMomentum.b_o[k];
        }
        
        for (let i = 0; i < 8; i++) {
            for (let j = 0; j < 2; j++) {
                const grad = lr * d_hidden[i] * input[j];
                this.#rnnMomentum.Wih[i][j] = momentum * this.#rnnMomentum.Wih[i][j] + grad;
                Wih[i][j] += this.#rnnMomentum.Wih[i][j];
            }
            for (let j = 0; j < 8; j++) {
                const grad = lr * d_hidden[i] * hidden[j];
                this.#rnnMomentum.Whh[i][j] = momentum * this.#rnnMomentum.Whh[i][j] + grad;
                Whh[i][j] += this.#rnnMomentum.Whh[i][j];
            }
            this.#rnnMomentum.b_h[i] = momentum * this.#rnnMomentum.b_h[i] + lr * d_hidden[i];
            b_h[i] += this.#rnnMomentum.b_h[i];
        }
    }

    // ==================== LOGISTIC REGRESSION ====================
    #computeLogisticEngine() {
        const h = this.#history;
        if (h.length < 5) return { prediction: 'T', confidence: 0.5, probT: 0.5, probX: 0.5 };
        
        const probEng = this.#computeProbabilityEngine();
        const momEng = this.#computeMomentumEngine();
        const feats = [probEng.probT, momEng.probT || 0.5];
        
        const { w, b } = this.#logisticWeights;
        const z = b + w[0] * feats[0] + w[1] * feats[1];
        const probT = 1 / (1 + Math.exp(-z));
        const probX = 1 - probT;
        const prediction = probT > 0.5 ? 'T' : 'X';
        const confidence = Math.min(1, Math.abs(probT - 0.5) * 2);
        
        return { prediction, confidence, probT, probX };
    }

    #trainLogistic(actual) {
        const target = actual === 'T' ? 1 : 0;
        const probEng = this.#computeProbabilityEngine();
        const momEng = this.#computeMomentumEngine();
        const feats = [probEng.probT, momEng.probT || 0.5];
        
        const z = this.#logisticWeights.b + 
                 this.#logisticWeights.w[0] * feats[0] + 
                 this.#logisticWeights.w[1] * feats[1];
        const p = 1 / (1 + Math.exp(-z));
        const error = target - p;
        const lr = 0.02;
        const momentum = 0.9;
        
        for (let i = 0; i < 2; i++) {
            const grad = lr * error * feats[i];
            this.#logisticMomentum.w[i] = momentum * this.#logisticMomentum.w[i] + grad;
            this.#logisticWeights.w[i] += this.#logisticMomentum.w[i];
        }
        this.#logisticMomentum.b = momentum * this.#logisticMomentum.b + lr * error;
        this.#logisticWeights.b += this.#logisticMomentum.b;
    }

    // ==================== META STACKING ====================
    #computeMetaStackingEngine() {
        const baseNames = [
            'pattern', 'probability', 'bayesian', 'markov', 'montecarlo',
            'momentum', 'state', 'risk', 'dice', 'balance', 'bootstrap1000',
            'rnn', 'logistic'
        ];
        const feats = [];
        for (let name of baseNames) {
            const p = this.#lastPredictions?.[name];
            feats.push(p && p.probT !== undefined ? p.probT : 0.5);
        }
        
        const { w, b } = this.#metaWeights;
        let z = b;
        for (let i = 0; i < feats.length; i++) z += w[i] * feats[i];
        const probT = 1 / (1 + Math.exp(-z));
        const probX = 1 - probT;
        const prediction = probT > 0.5 ? 'T' : 'X';
        const confidence = Math.min(1, Math.abs(probT - 0.5) * 2);
        
        return { prediction, confidence, probT, probX };
    }

    #trainMetaStack(actual) {
        if (!this.#lastPredictions) return;
        const target = actual === 'T' ? 1 : 0;
        const baseNames = [
            'pattern', 'probability', 'bayesian', 'markov', 'montecarlo',
            'momentum', 'state', 'risk', 'dice', 'balance', 'bootstrap1000',
            'rnn', 'logistic'
        ];
        const feats = [];
        for (let name of baseNames) {
            const p = this.#lastPredictions[name];
            feats.push(p && p.probT !== undefined ? p.probT : 0.5);
        }
        
        const z = this.#metaWeights.b + 
                 feats.reduce((s, v, i) => s + this.#metaWeights.w[i] * v, 0);
        const p = 1 / (1 + Math.exp(-z));
        const error = target - p;
        const lr = 0.005;
        const momentum = 0.9;
        
        for (let i = 0; i < feats.length; i++) {
            const grad = lr * error * feats[i];
            this.#metaMomentum.w[i] = momentum * this.#metaMomentum.w[i] + grad;
            this.#metaWeights.w[i] += this.#metaMomentum.w[i];
        }
        this.#metaMomentum.b = momentum * this.#metaMomentum.b + lr * error;
        this.#metaWeights.b += this.#metaMomentum.b;
    }

    // ==================== PLATT SCALING ====================
    #updatePlattScaling(actual) {
        const target = actual === 'T' ? 1 : 0;
        const metaScore = this.#lastMetaScore || 0;
        const p = plattScale(metaScore, this.#plattA, this.#plattB);
        const error = target - p;
        const lr = 0.01;
        
        this.#plattA += lr * error * metaScore;
        this.#plattB += lr * error;
        
        this.#plattA = Math.min(5, Math.max(0.1, this.#plattA));
        this.#plattB = Math.min(2, Math.max(-2, this.#plattB));
    }

    // ==================== 1000 BOOTSTRAP ====================
    #computeBootstrap1000Engine() {
        const h = this.#history;
        const len = h.length;
        if (len < 5) return { prediction: 'T', confidence: 0.5, probT: 0.5, probX: 0.5 };

        if (this.#bootstrapCache) return this.#bootstrapCache;

        const B = 1000;
        let sumProbT = 0;
        const predictions = new Array(B);

        for (let b = 0; b < B; b++) {
            let countT = 0;
            for (let i = 0; i < len; i++) {
                const idx = Math.floor(Math.random() * len);
                if (h[idx] === 'T') countT++;
            }
            const probT = countT / len;
            sumProbT += probT;
            predictions[b] = probT;
        }

        const avgProbT = sumProbT / B;
        const avgProbX = 1 - avgProbT;
        const prediction = avgProbT > 0.5 ? 'T' : 'X';

        const variance = predictions.reduce((s, p) => s + (p - avgProbT) ** 2, 0) / B;
        const std = Math.sqrt(variance);
        const confidence = Math.min(1, Math.abs(avgProbT - 0.5) * 2 * (1 - std * 2));

        const result = {
            prediction,
            confidence: Math.max(0.1, confidence),
            probT: avgProbT,
            probX: avgProbX,
            bootstrapStd: std,
            modelCount: B
        };

        this.#bootstrapCache = result;
        return result;
    }

    // ==================== ENSEMBLE ====================
    #ensembleMetaModel(enginePredictions) {
        const voters = [
            'pattern', 'probability', 'bayesian', 'markov', 'montecarlo',
            'momentum', 'state', 'risk', 'dice', 'balance', 'patternlearning',
            'bootstrap1000', 'rnn', 'logistic', 'metastack'
        ];
        let weightedT = 0, weightedX = 0;

        for (let name of voters) {
            const pred = enginePredictions[name];
            if (!pred || pred.prediction === undefined || pred.prediction === null) continue;
            const perf = this.#enginePerformance[name] || { accuracy: 0.5, stability: 0.5 };
            const recentAcc = perf.recentTotal > 0 ? perf.recentCorrect / perf.recentTotal : perf.accuracy;
            const dynamicWeight = recentAcc * pred.confidence * perf.stability;
            if (pred.prediction === 'T') weightedT += dynamicWeight;
            else if (pred.prediction === 'X') weightedX += dynamicWeight;
        }

        const total = weightedT + weightedX;
        let prediction, metaScore;
        if (total === 0) {
            prediction = 'T';
            metaScore = 0;
        } else {
            prediction = weightedT >= weightedX ? 'T' : 'X';
            metaScore = (weightedT - weightedX) / total;
        }
        this.#lastMetaScore = metaScore;
        return { prediction, metaScore, weightedTScore: weightedT, weightedXScore: weightedX };
    }

    // ==================== DYNAMIC WEIGHTS ====================
    #updateDynamicWeights() {
        const engines = Object.keys(this.#enginePerformance);
        const newWeights = {};
        for (let name of engines) {
            const perf = this.#enginePerformance[name];
            const recentAcc = perf.recentTotal > 0 ? perf.recentCorrect / perf.recentTotal : perf.accuracy;
            newWeights[name] = recentAcc * perf.stability;
        }
        const sum = Object.values(newWeights).reduce((a, b) => a + b, 0);
        if (sum > 0) {
            for (let name in newWeights) {
                newWeights[name] /= sum;
            }
        } else {
            for (let name in newWeights) newWeights[name] = 1 / engines.length;
        }
        this.#weights = newWeights;
    }

    // ==================== ANTI-OVERFITTING ====================
    #antiOverfittingLayer(enginePredictions, ensemblePrediction, metaScore) {
        const entropyRes = this.#computeEntropyIntelligence();
        let adjustedConf = Math.abs(metaScore);

        const noise = this.#computeNoiseFilterEngine().noiseLevel;
        adjustedConf *= (1 - noise * 0.5);

        if (entropyRes.level === 'CHAOTIC') {
            adjustedConf *= 0.3;
        } else if (entropyRes.level === 'HIGH') {
            adjustedConf *= 0.6;
        }

        const patternAI = enginePredictions.patternlearning;
        if (patternAI && patternAI.successRate !== undefined && patternAI.successRate < 0.55) {
            adjustedConf *= 0.8;
        }

        if (this.#lastChangePoint > this.#history.length - 50) {
            adjustedConf *= 0.7;
        }

        return Math.min(1, Math.max(0.1, adjustedConf));
    }

    // ==================== SMART CONFIDENCE ====================
    #smartConfidence(enginePredictions, prediction, antiOverfitConf) {
        let score = 0;
        let count = 0;

        const pat = enginePredictions.pattern;
        if (pat) {
            score += pat.confidence * 0.2;
            count += 0.2;
        }

        const prob = enginePredictions.probability;
        const bayes = enginePredictions.bayesian;
        if (prob && bayes) {
            const consensus = 1 - Math.abs(prob.probT - bayes.probT);
            score += consensus * 0.15;
            count += 0.15;
        }

        const entropyRes = this.#computeEntropyIntelligence();
        const entropyConf = 1 - entropyRes.entropy;
        score += entropyConf * 0.15;
        count += 0.15;

        const noise = enginePredictions.noisefilter?.noiseLevel || 0.5;
        score += (1 - noise) * 0.1;
        count += 0.1;

        const riskLevel = enginePredictions.risk?.riskLevel;
        const riskMap = { LOW: 1, MEDIUM: 0.6, HIGH: 0.3 };
        const riskConf = riskMap[riskLevel] || 0.5;
        score += riskConf * 0.1;
        count += 0.1;

        const accuracies = Object.values(this.#enginePerformance).map(p => p.accuracy);
        const avgAcc = accuracies.length > 0 ? accuracies.reduce((a, b) => a + b, 0) / accuracies.length : 0.5;
        score += avgAcc * 0.1;
        count += 0.1;

        const rnn = enginePredictions.rnn;
        if (rnn && rnn.confidence) {
            score += rnn.confidence * 0.1;
            count += 0.1;
        }

        const baseConf = count > 0 ? score / count : 0.5;
        return Math.min(1, Math.max(0.1, baseConf * 0.6 + antiOverfitConf * 0.4));
    }

    // ==================== DIAGNOSTICS ====================
    #calculateTrapProbability() {
        const h = this.#history;
        if (h.length < 5) return 0;
        let traps = 0;
        for (let i = 2; i < h.length; i++) {
            if (h[i] !== h[i - 1] && h[i] === h[i - 2]) traps++;
        }
        return traps / (h.length - 2);
    }

    #calculateReversalRisk() {
        const h = this.#history;
        if (h.length < 3) return 0.5;
        const streak = this.#computeStateEngine().confidence;
        return Math.min(1, streak * 0.8);
    }

    #calculateEngineAgreement(enginePredictions) {
        const predictions = Object.values(enginePredictions).filter(p => p && p.prediction).map(p => p.prediction);
        if (predictions.length === 0) return 0;
        const countT = predictions.filter(p => p === 'T').length;
        const agreement = Math.max(countT, predictions.length - countT) / predictions.length;
        return agreement;
    }

    #getEnginePrediction(name) {
        switch (name) {
            case 'pattern': return this.#computePatternEngine();
            case 'probability': return this.#computeProbabilityEngine();
            case 'bayesian': return this.#computeBayesianEngine();
            case 'markov': return this.#computeMarkovEngine();
            case 'montecarlo': return this.#computeMonteCarloEngine();
            case 'momentum': return this.#computeMomentumEngine();
            case 'state': return this.#computeStateEngine();
            case 'risk': return this.#computeRiskEngine();
            case 'dice': return this.#computeDiceAnalysisEngine();
            case 'balance': return this.#computeBalanceEngine();
            default: return { prediction: 'T', confidence: 0.5 };
        }
    }

    // ==================== PUBLIC UTILITIES ====================
    getHistory() { return [...this.#history]; }
    getPerformance() { return { ...this.#enginePerformance }; }
    getWeights() { return { ...this.#weights }; }

    reset() {
        this.#history = [];
        this.#sessionCount = 0;
        this.#patternCache.clear();
        this.#patternMemory = {};
        this.#markovChain = {};
        this.#markovOrderChains = { 1: null, 2: null, 3: null };
        this.#weights = {};
        this.#lastPredictions = {};
        this.#bootstrapCache = null;
        this.#rnnHiddenState = Array(8).fill(0);
        this.#lastChangePoint = 0;
        
        const engineNames = Object.keys(this.#enginePerformance);
        for (let name of engineNames) {
            this.#enginePerformance[name] = {
                correct: 0, total: 0, accuracy: 0.5, winrate: 0.5,
                drawdown: 0, maxDrawdown: 0, stability: 1.0, varianceAcc: 0,
                accHistory: [], recentCorrect: 0, recentTotal: 0
            };
        }
        this.#buildMarkovChains();
        this.#updateDynamicWeights();
    }
}

// ==================== QUANT ENGINE BRIDGE ====================
let globalEngineHu = null;
let globalEngineMd5 = null;

function getEngine(game, history) {
    const seq = history.map(s => s.ket_qua === 'Tài' ? 'T' : 'X');
    if (game === 'hu') {
        if (!globalEngineHu) globalEngineHu = new QuantEngineV22Omega(seq);
        return globalEngineHu;
    } else {
        if (!globalEngineMd5) globalEngineMd5 = new QuantEngineV22Omega(seq);
        return globalEngineMd5;
    }
}

function predictWithEngine(game, sessions) {
    const seq = sessions.map(s => s.ket_qua === 'Tài' ? 'T' : 'X');
    const engine = getEngine(game, sessions);
    // Cập nhật engine với lịch sử mới
    if (engine.getHistory().length !== seq.length) {
        // Nếu history khác, tạo engine mới
        const newEngine = new QuantEngineV22Omega(seq);
        if (game === 'hu') globalEngineHu = newEngine;
        else globalEngineMd5 = newEngine;
        const report = newEngine.predict();
        return {
            du_doan: report.prediction === 'T' ? 'Tài' : 'Xỉu',
            do_tin_cay: (report.confidence * 100).toFixed(2) + '%',
            calibratedConfidence: (report.calibratedConfidence * 100).toFixed(2) + '%',
            riskLevel: report.riskLevel,
            entropyLevel: report.entropyLevel,
            diagnostics: report.diagnostics,
            metaScore: report.metaScore
        };
    } else {
        const report = engine.predict();
        // Cập nhật engine với kết quả thực tế nếu có
        return {
            du_doan: report.prediction === 'T' ? 'Tài' : 'Xỉu',
            do_tin_cay: (report.confidence * 100).toFixed(2) + '%',
            calibratedConfidence: (report.calibratedConfidence * 100).toFixed(2) + '%',
            riskLevel: report.riskLevel,
            entropyLevel: report.entropyLevel,
            diagnostics: report.diagnostics,
            metaScore: report.metaScore
        };
    }
}

function updateEngineWithResult(game, actual) {
    const engine = game === 'hu' ? globalEngineHu : globalEngineMd5;
    if (engine) {
        engine.update(actual === 'Tài' ? 'T' : 'X');
    }
}

// ========== ĐỌC/GHI ==========
function loadJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch(e){} return null; }
function saveJSON(f, d) { fs.writeFileSync(f, JSON.stringify(d, null, 2), 'utf8'); }
function loadHistory(game) {
    const f = game === 'hu' ? HISTORY_HU_FILE : HISTORY_MD5_FILE;
    const d = loadJSON(f) || [];
    if (d.length > MAX_HISTORY) d.splice(0, d.length - MAX_HISTORY);
    return d;
}
function saveHistory(game, d) {
    const f = game === 'hu' ? HISTORY_HU_FILE : HISTORY_MD5_FILE;
    if (d.length > MAX_HISTORY) d.splice(0, d.length - MAX_HISTORY);
    saveJSON(f, d);
}

// ---------- TRANSFORM ----------
function transform(item) {
    return {
        phien: item.id || 0,
        xuc_xac: item.dices || [],
        tong: item.point || 0,
        ket_qua: item.resultTruyenThong === 'TAI' ? 'Tài' : 'Xỉu'
    };
}

// ---------- FETCH ----------
async function fetchWithRetry(url) {
    for (let i = 1; i <= RETRY_COUNT; i++) {
        try {
            const res = await axios.get(url, { timeout: TIMEOUT });
            return res;
        } catch (e) {
            if (i === RETRY_COUNT) throw e;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

// ---------- XỬ LÝ GAME ----------
function processData(game, list, isCache = false) {
    if (!list || list.length === 0) return null;
    const sorted = [...list].sort((a, b) => a.id - b.id);
    const full = sorted.map(transform).filter(s => s !== null);
    if (!full.length) return null;
    
    const recent = full.slice(-50);
    const last = recent[recent.length - 1];
    const phienHienTai = last.phien + 1;
    
    // Dự đoán
    const prediction = predictWithEngine(game, recent);
    if (!prediction) return null;
    
    // Lưu lịch sử
    if (!isCache) {
        const history = loadHistory(game);
        const prev = history.find(r => r.phien === last.phien);
        if (prev && prev.ket_qua === null) {
            prev.ket_qua = last.ket_qua;
            prev.danh_gia = (prev.du_doan === last.ket_qua) ? '✅ Thắng' : '❌ Thua';
            // Cập nhật engine với kết quả thực tế
            updateEngineWithResult(game, last.ket_qua);
            saveHistory(game, history);
        }
        if (!history.find(r => r.phien === phienHienTai)) {
            history.push({
                phien: phienHienTai,
                du_doan: prediction.du_doan,
                ket_qua: null,
                danh_gia: null,
                thoi_gian: new Date().toISOString()
            });
            saveHistory(game, history);
        }
    }
    
    return {
        phien_truoc: last.phien,
        xuc_xac: last.xuc_xac,
        tong: last.tong,
        ket_qua: last.ket_qua,
        phien_hien_tai: phienHienTai,
        du_doan: prediction.du_doan,
        do_tin_cay: prediction.do_tin_cay,
        calibratedConfidence: prediction.calibratedConfidence,
        riskLevel: prediction.riskLevel,
        entropyLevel: prediction.entropyLevel,
        metaScore: prediction.metaScore,
        diagnostics: prediction.diagnostics,
        version: 'UNLTRA PRO V7.0 – QUANT ENGINE V22 OMEGA',
        engine_info: '19 models ensemble (RNN + Logistic + MetaStacking + Bootstrap1000)'
    };
}

// ---------- FETCH TỰ ĐỘNG ----------
async function autoFetch() {
    try { await Promise.all([processGame('hu', API_HU), processGame('md5', API_MD5)]); } catch(e) { console.error(e.message); }
}

async function processGame(game, apiUrl) {
    try {
        const response = await fetchWithRetry(apiUrl);
        const list = response.data?.list || [];
        if (!list.length) return console.log(`[${game}] No data`);
        if (game === 'hu') { cacheHu = list; cacheHuTime = Date.now(); } else { cacheMd5 = list; cacheMd5Time = Date.now(); }
        const result = processData(game, list, false);
        if (result) console.log(`[${game}] ✅ ${result.phien_truoc}->${result.phien_hien_tai} | ${result.du_doan} (${result.do_tin_cay})`);
    } catch (error) {
        console.log(`[${game}] ❌ ${error.message}, using cache`);
        const list = game === 'hu' ? cacheHu : cacheMd5;
        const time = game === 'hu' ? cacheHuTime : cacheMd5Time;
        if (list && (Date.now() - time < 30000)) {
            const result = processData(game, list, true);
            if (result) console.log(`[${game}] 📦 Cache: ${result.phien_truoc}->${result.phien_hien_tai} | ${result.du_doan} (${result.do_tin_cay})`);
        }
    }
}

setTimeout(autoFetch, 3000);
setInterval(autoFetch, 20000);

// ---------- ENDPOINTS ----------
app.get('/api/lc79/hu', async (req, res) => {
    try {
        const response = await fetchWithRetry(API_HU);
        const list = response.data?.list || [];
        if (list.length) { cacheHu = list; cacheHuTime = Date.now(); const result = processData('hu', list, false); return res.json(result || {error:'No data'}); }
        throw new Error('Empty');
    } catch(e) {
        if (cacheHu && (Date.now() - cacheHuTime < 30000)) return res.json(processData('hu', cacheHu, true));
        res.status(500).json({ error: 'Không thể lấy dữ liệu và không có cache' });
    }
});

app.get('/api/lc79/md5', async (req, res) => {
    try {
        const response = await fetchWithRetry(API_MD5);
        const list = response.data?.list || [];
        if (list.length) { cacheMd5 = list; cacheMd5Time = Date.now(); const result = processData('md5', list, false); return res.json(result || {error:'No data'}); }
        throw new Error('Empty');
    } catch(e) {
        if (cacheMd5 && (Date.now() - cacheMd5Time < 30000)) return res.json(processData('md5', cacheMd5, true));
        res.status(500).json({ error: 'Không thể lấy dữ liệu và không có cache' });
    }
});

app.get('/api/hu/history', (req, res) => {
    let h = loadHistory('hu');
    h.sort((a, b) => b.phien - a.phien);
    h = h.map(r => ({ ...r, ket_qua: r.ket_qua || '⌛ Chờ Kết Quả', danh_gia: r.danh_gia || '⌛ Chờ Kết Quả' }));
    res.json(h);
});

app.get('/api/md5/history', (req, res) => {
    let h = loadHistory('md5');
    h.sort((a, b) => b.phien - a.phien);
    h = h.map(r => ({ ...r, ket_qua: r.ket_qua || '⌛ Chờ Kết Quả', danh_gia: r.danh_gia || '⌛ Chờ Kết Quả' }));
    res.json(h);
});

app.get('/api/engine/status', (req, res) => {
    res.json({
        version: 'UNLTRA PRO V7.0 – QUANT ENGINE V22 OMEGA',
        engine_class: 'QuantEngineV22Omega',
        models: 19,
        features: ['RNN', 'Logistic Regression', 'MetaStacking', 'Bootstrap1000', 
                   'Attention Mechanism', 'Change Point Detection', 'Platt Scaling'],
        history: { hu: loadHistory('hu').length, md5: loadHistory('md5').length },
        cache: { hu: !!cacheHu, md5: !!cacheMd5 }
    });
});

app.get('/api/engine/perf', (req, res) => {
    const huEngine = globalEngineHu;
    const md5Engine = globalEngineMd5;
    res.json({
        hu: huEngine ? huEngine.getPerformance() : null,
        md5: md5Engine ? md5Engine.getPerformance() : null
    });
});

app.post('/api/reset', (req, res) => {
    globalEngineHu = null;
    globalEngineMd5 = null;
    saveJSON(HISTORY_HU_FILE, []);
    saveJSON(HISTORY_MD5_FILE, []);
    res.json({ success: true, message: 'Reset toàn bộ dữ liệu và engine' });
});

app.get('/ping', (req, res) => res.send('pong'));

app.listen(PORT, () => {
    console.log(`🚀 UNLTRA PRO V7.0 – QUANT ENGINE V22 OMEGA`);
    console.log(`📡 Port ${PORT}`);
    console.log(`🧠 19 models ensemble (RNN + Logistic + MetaStacking + Bootstrap1000)`);
    console.log(`⚡ Features: Attention, Change Point Detection, Platt Scaling`);
});
