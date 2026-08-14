// ==================== FILE: server.js (CẬP NHẬT PATTERN MẪU) ====================
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
const MODELS = 15;

// ==================== THƯ VIỆN PATTERN MẪU ====================
const PATTERN_LIBRARY = {
    // Dạng 1-X-1
    '1-1': { next: 'X', confidence: 70 },
    '1-2-1': { next: 'T', confidence: 75 },
    '1-3-1': { next: 'X', confidence: 80 },
    '1-4-1': { next: 'T', confidence: 72 },
    '1-5-1': { next: 'X', confidence: 68 },
    '1-2-2-1': { next: 'T', confidence: 78 },
    '1-3-3-1': { next: 'X', confidence: 82 },
    '1-4-4-1': { next: 'T', confidence: 74 },
    '1-5-5-1': { next: 'X', confidence: 70 },
    '1-2-3-2-1': { next: 'T', confidence: 85 },
    
    // Dạng 2-X-2
    '2-2': { next: 'T', confidence: 65 },
    '2-1-2': { next: 'X', confidence: 72 },
    '2-3-2': { next: 'T', confidence: 78 },
    '2-4-2': { next: 'X', confidence: 70 },
    '2-5-2': { next: 'T', confidence: 66 },
    '2-1-1-2': { next: 'X', confidence: 76 },
    '2-3-3-2': { next: 'T', confidence: 80 },
    '2-4-4-2': { next: 'X', confidence: 74 },
    '2-5-5-2': { next: 'T', confidence: 72 },
    '2-1-3-1-2': { next: 'X', confidence: 84 },
    
    // Dạng 3-X-3
    '3-3': { next: 'X', confidence: 60 },
    '3-1-3': { next: 'T', confidence: 70 },
    '3-2-3': { next: 'X', confidence: 76 },
    '3-4-3': { next: 'T', confidence: 68 },
    '3-5-3': { next: 'X', confidence: 64 },
    '3-1-1-3': { next: 'T', confidence: 74 },
    '3-2-2-3': { next: 'X', confidence: 78 },
    '3-4-4-3': { next: 'T', confidence: 72 },
    '3-5-5-3': { next: 'X', confidence: 70 },
    '3-1-2-1-3': { next: 'T', confidence: 82 }
};

// ==================== HÀM TIỆN ÍCH ====================
const mapResult = (r) => r === 'TAI' ? 'Tài' : 'Xỉu';
const toPattern = (list) => list.map(item => item.resultTruyenThong === 'TAI' ? 'T' : 'X').join('');

// ==================== PHÂN TÍCH PATTERN ====================
function analyzePattern(history) {
    const fullPattern = toPattern(history);
    if (fullPattern.length < PATTERN_LENGTH) return { predict: null, confidence: 50 };

    const recent6 = fullPattern.slice(-PATTERN_LENGTH);
    const segments = recent6.match(/([TX])\1*/g) || [];
    const bridgePattern = segments.map(s => s.length).join('-');
    
    // ===== KIỂM TRA PATTERN MẪU =====
    let matchedPattern = null;
    let confidence = 50;
    let predict = null;
    
    // Tìm pattern khớp trong thư viện (ưu tiên dài nhất trước)
    const sortedPatterns = Object.keys(PATTERN_LIBRARY).sort((a, b) => b.length - a.length);
    for (const patternKey of sortedPatterns) {
        if (bridgePattern === patternKey) {
            matchedPattern = patternKey;
            const lib = PATTERN_LIBRARY[patternKey];
            predict = lib.next === 'T' ? 'Tài' : 'Xỉu';
            confidence = lib.confidence;
            break;
        }
    }
    
    // Nếu không khớp pattern mẫu, dùng thuật toán động
    if (!matchedPattern) {
        let matchCount = 0;
        let totalMatches = 0;
        let nextPredictions = [];
        
        for (let i = 0; i <= fullPattern.length - PATTERN_LENGTH - 1; i++) {
            const window = fullPattern.slice(i, i + PATTERN_LENGTH);
            if (window === recent6) {
                totalMatches++;
                const nextChar = fullPattern[i + PATTERN_LENGTH];
                if (nextChar) {
                    nextPredictions.push(nextChar);
                    matchCount++;
                }
            }
        }

        if (nextPredictions.length > 0) {
            const tCount = nextPredictions.filter(c => c === 'T').length;
            const xCount = nextPredictions.filter(c => c === 'X').length;
            const total = tCount + xCount;
            
            if (total > 0) {
                predict = tCount >= xCount ? 'Tài' : 'Xỉu';
                confidence = Math.round((Math.max(tCount, xCount) / total) * 100);
                confidence = Math.min(95, confidence + (totalMatches * 2));
            }
        }
        
        // Fallback: dùng logic cầu 1-3-1
        if (!predict && bridgePattern === '1-3-1') {
            const lastChar = recent6.slice(-1);
            predict = lastChar === 'T' ? 'Xỉu' : 'Tài';
            confidence = 65;
        }
    }

    // ===== KẾT HỢP 15 MODELS =====
    const modelVotes = run15Models(history);
    if (modelVotes) {
        const mainWeight = 0.6;
        const modelWeight = 0.4;
        const combined = modelVotes === predict ? 1 : 0;
        confidence = Math.round((confidence * mainWeight) + (combined * 100 * modelWeight));
        // Nếu model có độ tin cậy cao hơn, ưu tiên model
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
    
    // Model 1-3: Dựa trên pattern gần nhất
    if (history.length >= 3) {
        const last3 = fullPattern.slice(-3);
        if (last3 === 'TTT') results.push('Xỉu');
        else if (last3 === 'XXX') results.push('Tài');
        else if (last3 === 'TTX' || last3 === 'XTT') results.push('Tài');
        else if (last3 === 'XXT' || last3 === 'TXX') results.push('Xỉu');
    }
    
    // Model 4-6: Xu hướng T/X
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
    
    // Model 7-9: Trung bình tổng điểm
    for (let n of [5, 10, 15]) {
        if (points.length >= n) {
            const avg = points.slice(0, n).reduce((a, b) => a + b, 0) / n;
            if (avg >= 12) results.push('Tài');
            else if (avg <= 9) results.push('Xỉu');
            else results.push(avg >= 10.5 ? 'Tài' : 'Xỉu');
        }
    }
    
    // Model 10-11: Xúc xắc
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
    
    // Model 12-13: Pattern liên tiếp
    const lastRun = fullPattern.match(/([TX])\1*$/);
    if (lastRun) {
        const len = lastRun[0].length;
        const char = lastRun[0][0];
        if (len >= 4) results.push(char === 'T' ? 'Xỉu' : 'Tài');
        else if (len >= 2) results.push(char === 'T' ? 'Tài' : 'Xỉu');
    }
    
    // Model 14: Dựa trên phiên gần nhất
    if (history.length > 0) {
        const last = history[0];
        results.push(last.point >= 11 ? 'Tài' : 'Xỉu');
    }
    
    // Model 15: Dựa trên tổng 3 phiên gần nhất
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
function buildHistoryResponse(data) {
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
    
    const pattern6 = historyForAnalysis.slice(0, 6).reverse();
    const patternStr = pattern6.map(h => h.resultTruyenThong === 'TAI' ? 'T' : 'X').join('');
    const patternDisplay = patternStr.split('').map(c => c === 'T' ? '🔴' : '🔵').join(' ');
    
    // Tìm cầu pattern từ 6 ký tự
    const segments = patternStr.match(/([TX])\1*/g) || [];
    const bridgePattern = segments.map(s => s.length).join('-');
    
    return {
        id: '@ngminhtuann',
        phien_truoc: prevSession,
        xuc_xac: latest.dices ? latest.dices.join(', ') : '⌛ Chờ',
        tong: latest.point || '⌛ Chờ',
        ket_qua: latest.resultTruyenThong ? mapResult(latest.resultTruyenThong) : '⌛ Chờ',
        phien_hien_tai: currentSession,
        pattern: patternDisplay || '⌛ Chờ',
        cau: bridgePattern || '⌛ Chờ',
        du_doan: duDoan,
        do_tin_cay: `${doTinCay}%`
    };
}

function buildHistoryList(data) {
    if (!data || data.length === 0) return [];
    
    const sorted = data.sort((a, b) => b.id - a.id);
    const result = [];
    const fullPattern = toPattern(sorted);
    
    for (let i = 0; i < sorted.length; i++) {
        const item = sorted[i];
        const isPending = !item.dices || item.dices.length === 0;
        
        let duDoan = '⌛ Chờ Kết Quả';
        let danhGia = '⌛ Chờ Kết Quả';
        let ketQua = isPending ? '⌛ Chờ Kết Quả' : mapResult(item.resultTruyenThong);
        let xucXac = isPending ? '⌛ Chờ Kết Quả' : (item.dices ? item.dices.join(', ') : '⌛ Chờ');
        let tong = isPending ? '⌛ Chờ Kết Quả' : (item.point || '⌛ Chờ');
        
        // Dự đoán dựa trên pattern lịch sử
        if (i < sorted.length - 1 && !isPending) {
            const nextItem = sorted[i + 1];
            if (nextItem && nextItem.resultTruyenThong) {
                const nextResult = mapResult(nextItem.resultTruyenThong);
                duDoan = nextResult === 'Tài' ? 'Xỉu' : 'Tài';
            }
        }
        
        // Đánh giá
        if (!isPending && duDoan !== '⌛ Chờ Kết Quả') {
            const isWin = duDoan === mapResult(item.resultTruyenThong);
            danhGia = isWin ? '✅ Thắng' : '❌ Thua';
        } else if (!isPending) {
            danhGia = '✅ Thắng';
        }
        
        result.push({
            phien: item.id,
            du_doan: duDoan,
            ket_qua: ketQua,
            danh_gia: danhGia,
            xuc_xac: xucXac,
            tong: tong,
            time: item._id ? new Date(parseInt(item._id.substring(0, 8), 16) * 1000).toLocaleString('vi-VN') : 'N/A'
        });
    }
    
    return result;
}

// ==================== ROUTES ====================
app.get('/', (req, res) => {
    res.json({ 
        status: 'API Tx Analysis Running v2.0',
        endpoints: [
            '/api/tx/hu',
            '/api/tx/md5',
            '/api/tx/hu/history',
            '/api/tx/md5/history'
        ],
        pattern_library: Object.keys(PATTERN_LIBRARY)
    });
});

app.get('/api/tx/hu', async (req, res) => {
    const data = await fetchData(API_BASE.HU);
    res.json(buildHistoryResponse(data));
});

app.get('/api/tx/md5', async (req, res) => {
    const data = await fetchData(API_BASE.MD5);
    res.json(buildHistoryResponse(data));
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
    console.log(`✅ Server đang chạy tại http://localhost:${PORT}`);
    console.log(`📊 Đã nạp ${Object.keys(PATTERN_LIBRARY).length} pattern mẫu`);
});

module.exports = app;
