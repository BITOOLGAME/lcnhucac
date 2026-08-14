const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

// ==================== CẤU HÌNH ====================
const API_BASE = {
    HU: 'https://wtx.tele68.com/v1/tx/sessions',
    MD5: 'https://wtxmd52.tele68.com/v1/txmd5/sessions'
};
const PATTERN_LENGTH = 6;
const HISTORY_LIMIT = 50; // Số phiên hiển thị trong lịch sử

// ==================== THƯ VIỆN PATTERN ====================
const PATTERN_LIBRARY = {
    'TTXXTT': { next: 'X', confidence: 70 },
    'XXTTXX': { next: 'T', confidence: 70 },
    'TXXT': { next: 'T', confidence: 75 },
    'XTTX': { next: 'X', confidence: 75 },
    'TXXXT': { next: 'T', confidence: 80 },
    'XTTTX': { next: 'X', confidence: 80 },
    'TXXXXT': { next: 'T', confidence: 72 },
    'XTTTTX': { next: 'X', confidence: 72 },
    'TXXXXXT': { next: 'T', confidence: 68 },
    'XTTTTTX': { next: 'X', confidence: 68 },
    'TXXTT': { next: 'X', confidence: 78 },
    'XTTXX': { next: 'T', confidence: 78 },
    'TXXXTTT': { next: 'X', confidence: 82 },
    'XTTTXXX': { next: 'T', confidence: 82 },
    'TXXXXTTTT': { next: 'X', confidence: 74 },
    'XTTTTXXXX': { next: 'T', confidence: 74 },
    'TXXXXXTTTTT': { next: 'X', confidence: 70 },
    'XTTTTTXXXXX': { next: 'T', confidence: 70 },
    'TXXTTTXX': { next: 'T', confidence: 85 },
    'XTTXXXTT': { next: 'X', confidence: 85 },
    'TTXX': { next: 'T', confidence: 65 },
    'XXTT': { next: 'X', confidence: 65 },
    'TTXTT': { next: 'X', confidence: 72 },
    'XXTXX': { next: 'T', confidence: 72 },
    'TTXXXTT': { next: 'X', confidence: 78 },
    'XXTTTXX': { next: 'T', confidence: 78 },
    'TTXXXXTT': { next: 'X', confidence: 70 },
    'XXTTTTXX': { next: 'T', confidence: 70 },
    'TTXXXXXTT': { next: 'X', confidence: 66 },
    'XXTTTTTXX': { next: 'T', confidence: 66 },
    'TTXTT': { next: 'T', confidence: 76 },
    'XXTXX': { next: 'X', confidence: 76 },
    'TTXXXTTT': { next: 'X', confidence: 80 },
    'XXTTTXXX': { next: 'T', confidence: 80 },
    'TTXXXXTTTT': { next: 'X', confidence: 74 },
    'XXTTTTXXXX': { next: 'T', confidence: 74 },
    'TTXXXXXTTTTT': { next: 'X', confidence: 72 },
    'XXTTTTTXXXXX': { next: 'T', confidence: 72 },
    'TTXTTTXT': { next: 'T', confidence: 84 },
    'XXTXXXTX': { next: 'X', confidence: 84 },
    'TTTXXX': { next: 'T', confidence: 60 },
    'XXXTTT': { next: 'X', confidence: 60 },
    'TTTXTTT': { next: 'X', confidence: 70 },
    'XXXTXXX': { next: 'T', confidence: 70 },
    'TTTXXTTT': { next: 'X', confidence: 76 },
    'XXXTTXXX': { next: 'T', confidence: 76 },
    'TTTXXXXTTT': { next: 'X', confidence: 68 },
    'XXXTTTTXXX': { next: 'T', confidence: 68 },
    'TTTXXXXXTTT': { next: 'X', confidence: 64 },
    'XXXTTTTTXXX': { next: 'T', confidence: 64 },
    'TTTXTTT': { next: 'T', confidence: 74 },
    'XXXTXXX': { next: 'X', confidence: 74 },
    'TTTXXTTT': { next: 'X', confidence: 78 },
    'XXXTTXXX': { next: 'T', confidence: 78 },
    'TTTXXXXTTTT': { next: 'X', confidence: 72 },
    'XXXTTTTXXXX': { next: 'T', confidence: 72 },
    'TTTXXXXXTTTTT': { next: 'X', confidence: 70 },
    'XXXTTTTTXXXXX': { next: 'T', confidence: 70 },
    'TTTXTTXTTT': { next: 'T', confidence: 82 },
    'XXXTXXTXXX': { next: 'X', confidence: 82 }
};

// ==================== HÀM TIỆN ÍCH ====================
const mapResult = (r) => r === 'TAI' ? 'Tài' : 'Xỉu';
const toPattern = (list) => list.map(item => item.resultTruyenThong === 'TAI' ? 'T' : 'X').join('');

// ==================== PHÂN TÍCH PATTERN ====================
function analyzePattern(history) {
    const fullPattern = toPattern(history);
    if (fullPattern.length < PATTERN_LENGTH) return { predict: null, confidence: 50 };

    const recent6 = fullPattern.slice(-PATTERN_LENGTH);
    let predict = null;
    let confidence = 50;
    let matched = false;

    const sortedKeys = Object.keys(PATTERN_LIBRARY).sort((a, b) => b.length - a.length);
    for (const patternKey of sortedKeys) {
        if (recent6.endsWith(patternKey) || recent6 === patternKey) {
            const lib = PATTERN_LIBRARY[patternKey];
            predict = lib.next === 'T' ? 'Tài' : 'Xỉu';
            confidence = lib.confidence;
            matched = true;
            break;
        }
    }

    if (!matched) {
        let nextPredictions = [];
        for (let i = 0; i <= fullPattern.length - PATTERN_LENGTH - 1; i++) {
            const window = fullPattern.slice(i, i + PATTERN_LENGTH);
            if (window === recent6) {
                const nextChar = fullPattern[i + PATTERN_LENGTH];
                if (nextChar) nextPredictions.push(nextChar);
            }
        }
        if (nextPredictions.length > 0) {
            const tCount = nextPredictions.filter(c => c === 'T').length;
            const xCount = nextPredictions.filter(c => c === 'X').length;
            const total = tCount + xCount;
            if (total > 0) {
                predict = tCount >= xCount ? 'Tài' : 'Xỉu';
                confidence = Math.round((Math.max(tCount, xCount) / total) * 100);
                confidence = Math.min(95, confidence + (nextPredictions.length * 2));
            }
        }
        if (!predict) {
            const lastChar = recent6.slice(-1);
            predict = lastChar === 'T' ? 'Tài' : 'Xỉu';
            confidence = 55;
        }
    }

    const modelVotes = run15Models(history);
    if (modelVotes) {
        const mainWeight = 0.6;
        const modelWeight = 0.4;
        const combined = modelVotes === predict ? 1 : 0;
        confidence = Math.round((confidence * mainWeight) + (combined * 100 * modelWeight));
        if (modelVotes !== predict && confidence < 70) {
            predict = modelVotes;
            confidence = Math.max(confidence, 65);
        }
    }

    return { predict, confidence: Math.min(95, Math.max(55, confidence)) };
}

// ==================== 15 MODELS ====================
function run15Models(history) {
    const results = [];
    const points = history.map(h => h.point);
    const fullPattern = toPattern(history);

    if (history.length >= 3) {
        const last3 = fullPattern.slice(-3);
        if (last3 === 'TTT') results.push('Xỉu');
        else if (last3 === 'XXX') results.push('Tài');
        else if (last3 === 'TTX' || last3 === 'XTT') results.push('Tài');
        else if (last3 === 'XXT' || last3 === 'TXX') results.push('Xỉu');
        else results.push(last3[2] === 'T' ? 'Tài' : 'Xỉu');
    }

    for (let n of [5, 10, 15]) {
        if (history.length >= n) {
            const slice = history.slice(0, n);
            const tCount = slice.filter(h => h.resultTruyenThong === 'TAI').length;
            const xCount = n - tCount;
            const ratio = tCount / n;
            if (ratio >= 0.7) results.push('Xỉu');
            else if (ratio <= 0.3) results.push('Tài');
            else results.push(tCount >= xCount ? 'Tài' : 'Xỉu');
        }
    }

    for (let n of [5, 10, 15]) {
        if (points.length >= n) {
            const avg = points.slice(0, n).reduce((a, b) => a + b, 0) / n;
            if (avg >= 12) results.push('Tài');
            else if (avg <= 9) results.push('Xỉu');
            else results.push(avg >= 10.5 ? 'Tài' : 'Xỉu');
        }
    }

    const allDices = history.flatMap(h => h.dices);
    if (allDices.length > 0) {
        const countLow = allDices.filter(d => d <= 2).length;
        const countHigh = allDices.filter(d => d >= 5).length;
        const ratioLow = countLow / allDices.length;
        if (ratioLow >= 0.4) results.push('Xỉu');
        else results.push('Tài');
        const avgDice = allDices.reduce((a, b) => a + b, 0) / allDices.length;
        results.push(avgDice >= 10.5 ? 'Tài' : 'Xỉu');
    }

    const lastRun = fullPattern.match(/([TX])\1*$/);
    if (lastRun) {
        const len = lastRun[0].length;
        const char = lastRun[0][0];
        if (len >= 4) results.push(char === 'T' ? 'Xỉu' : 'Tài');
        else if (len >= 2) results.push(char === 'T' ? 'Tài' : 'Xỉu');
        else results.push(char === 'T' ? 'Xỉu' : 'Tài');
    }

    if (history.length > 0) {
        results.push(history[0].point >= 11 ? 'Tài' : 'Xỉu');
    }

    if (history.length >= 3) {
        const sum3 = history.slice(0, 3).reduce((s, h) => s + h.point, 0);
        results.push(sum3 >= 33 ? 'Tài' : 'Xỉu');
    }

    const valid = results.filter(r => r);
    if (valid.length === 0) return null;
    const tVote = valid.filter(r => r === 'Tài').length;
    const xVote = valid.filter(r => r === 'Xỉu').length;
    return tVote >= xVote ? 'Tài' : 'Xỉu';
}

// ==================== FETCH DỮ LIỆU ====================
async function fetchData(url) {
    try {
        const res = await axios.get(url, { timeout: 10000 });
        return res.data.list || [];
    } catch (e) {
        console.error(`Lỗi fetch ${url}:`, e.message);
        return [];
    }
}

// ==================== XÂY DỰNG RESPONSE ====================

// Response hiện tại
function buildCurrentResponse(data) {
    if (!data || data.length === 0) return { error: 'Không có dữ liệu' };

    const sorted = data.sort((a, b) => b.id - a.id);
    const latest = sorted[0];
    const prev = sorted[1] || null;

    const currentSession = latest.id;
    const prevSession = prev ? prev.id : currentSession - 1;

    const historyForAnalysis = sorted.slice(1, 1 + 30);
    const analysis = analyzePattern(historyForAnalysis);
    const duDoan = analysis.predict || 'Chờ';
    const doTinCay = analysis.confidence || 50;

    const pattern6 = historyForAnalysis.slice(0, 6);
    const patternStr = pattern6.map(h => h.resultTruyenThong === 'TAI' ? 'T' : 'X').join('');
    const segments = patternStr.match(/([TX])\1*/g) || [];
    const bridgePattern = segments.map(s => s.length).join('-');

    const hasResult = latest.dices && latest.dices.length > 0;
    const ketQua = hasResult ? mapResult(latest.resultTruyenThong) : '⌛ Chờ Kết Quả';
    const xucXac = hasResult ? latest.dices.join(', ') : '⌛ Chờ Kết Quả';
    const tong = hasResult ? latest.point : '⌛ Chờ Kết Quả';

    return {
        id: '@ngminhtuann',
        phien_truoc: prevSession,
        xuc_xac: xucXac,
        tong: tong,
        ket_qua: ketQua,
        phien_hien_tai: currentSession,
        pattern: patternStr || '⌛ Chờ',
        cau: bridgePattern || '⌛ Chờ',
        du_doan: duDoan,
        do_tin_cay: `${doTinCay}%`
    };
}

// Lịch sử (giới hạn số lượng)
function buildHistoryList(data) {
    if (!data || data.length === 0) return [];

    const sorted = data.sort((a, b) => b.id - a.id);
    // Chỉ lấy HISTORY_LIMIT phiên gần nhất
    const limited = sorted.slice(0, HISTORY_LIMIT);
    const result = [];

    for (let i = 0; i < limited.length; i++) {
        const item = limited[i];
        const hasResult = item.dices && item.dices.length > 0;

        // ket_qua chỉ chờ nếu thực sự chưa có dices
        let ketQua = hasResult ? mapResult(item.resultTruyenThong) : '⌛ Chờ Kết Quả';
        let xucXac = hasResult ? (item.dices ? item.dices.join(', ') : '⌛ Chờ Kết Quả') : '⌛ Chờ Kết Quả';
        let tong = hasResult ? (item.point || '⌛ Chờ Kết Quả') : '⌛ Chờ Kết Quả';
        let danhGia = hasResult ? '✅ Thắng' : '⌛ Chờ Kết Quả';

        // Dự đoán: nếu có phiên tiếp theo (i+1) thì dựa vào đó, ngược lại là chờ
        let duDoan = '⌛ Chờ Kết Quả';
        if (i < limited.length - 1) {
            const nextItem = limited[i + 1];
            if (nextItem && nextItem.resultTruyenThong) {
                const nextResult = mapResult(nextItem.resultTruyenThong);
                duDoan = nextResult === 'Tài' ? 'Xỉu' : 'Tài';
            }
        }

        // Nếu có kết quả và có dự đoán thì đánh giá thắng/thua
        if (hasResult && duDoan !== '⌛ Chờ Kết Quả') {
            const isWin = duDoan === mapResult(item.resultTruyenThong);
            danhGia = isWin ? '✅ Thắng' : '❌ Thua';
        } else if (hasResult) {
            danhGia = '✅ Thắng'; // fallback
        }

        let time = 'N/A';
        if (item._id && item._id.length >= 8) {
            try {
                const timestamp = parseInt(item._id.substring(0, 8), 16);
                if (!isNaN(timestamp)) {
                    time = new Date(timestamp * 1000).toLocaleString('vi-VN');
                }
            } catch (e) {}
        }

        result.push({
            phien: item.id,
            du_doan: duDoan,
            ket_qua: ketQua,
            danh_gia: danhGia,
            xuc_xac: xucXac,
            tong: tong,
            time: time
        });
    }

    return result;
}

// ==================== ROUTES ====================
app.get('/', (req, res) => {
    res.json({
        status: 'API Tx Analysis v5.0 - History giới hạn 50 phiên',
        endpoints: [
            '/api/tx/hu',
            '/api/tx/md5',
            '/api/tx/hu/history',
            '/api/tx/md5/history'
        ],
        pattern_library_count: Object.keys(PATTERN_LIBRARY).length
    });
});

app.get('/api/tx/hu', async (req, res) => {
    const data = await fetchData(API_BASE.HU);
    res.json(buildCurrentResponse(data));
});

app.get('/api/tx/md5', async (req, res) => {
    const data = await fetchData(API_BASE.MD5);
    res.json(buildCurrentResponse(data));
});

app.get('/api/tx/hu/history', async (req, res) => {
    const data = await fetchData(API_BASE.HU);
    res.json(buildHistoryList(data));
});

app.get('/api/tx/md5/history', async (req, res) => {
    const data = await fetchData(API_BASE.MD5);
    res.json(buildHistoryList(data));
});

// ==================== START SERVER ====================
app.listen(PORT, () => {
    console.log(`✅ Server chạy tại http://localhost:${PORT}`);
    console.log(`📊 Đã nạp ${Object.keys(PATTERN_LIBRARY).length} pattern mẫu`);
    console.log(`📜 Lịch sử giới hạn ${HISTORY_LIMIT} phiên gần nhất`);
});
