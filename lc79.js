const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

const PORT = process.env.PORT || 3000;
const SOURCE_API = "https://wtxmd52.tele68.com/v1/txmd5/sessions";

const MAX_SOURCE_HISTORY = 50;
const MAX_PATTERN_HISTORY = 20;
const MAX_ANALYZE_PATTERN = 12;
const MAX_PREDICTION_HISTORY = 50;

const CACHE_MS = 3000;
const PREDICTION_FILE = path.join(
    __dirname,
    "predictions.json"
);

let cache = {
    time: 0,
    history: [],
    pattern: "",
    prediction: null,
    next: null
};

let predictionHistory = loadPredictions();

/*
|--------------------------------------------------------------------------
| UTIL
|--------------------------------------------------------------------------
*/

function clamp(value, min, max) {
    return Math.max(
        min,
        Math.min(max, value)
    );
}

function tx(value) {
    return value === "Tài"
        ? "T"
        : "X";
}

function result(value) {
    return value === "T"
        ? "Tài"
        : "Xỉu";
}

function opposite(value) {
    return value === "T"
        ? "X"
        : "T";
}

function invertPattern(pattern) {
    return pattern
        .split("")
        .map(v =>
            v === "T"
                ? "X"
                : "T"
        )
        .join("");
}

function sleep(ms) {
    return new Promise(resolve =>
        setTimeout(resolve, ms)
    );
}

/*
|--------------------------------------------------------------------------
| PERSISTENCE
|--------------------------------------------------------------------------
*/

function loadPredictions() {
    try {
        if (
            !fs.existsSync(
                PREDICTION_FILE
            )
        ) {
            fs.writeFileSync(
                PREDICTION_FILE,
                "[]",
                "utf8"
            );

            return [];
        }

        const raw =
            fs.readFileSync(
                PREDICTION_FILE,
                "utf8"
            );

        const data =
            JSON.parse(raw);

        if (!Array.isArray(data)) {
            return [];
        }

        return data
            .sort(
                (a, b) =>
                    Number(a.phien) -
                    Number(b.phien)
            )
            .slice(
                -MAX_PREDICTION_HISTORY
            );
    } catch (error) {
        console.error(
            "LOAD ERROR:",
            error.message
        );

        return [];
    }
}

function savePredictions() {
    try {
        predictionHistory =
            predictionHistory.slice(
                -MAX_PREDICTION_HISTORY
            );

        fs.writeFileSync(
            PREDICTION_FILE,
            JSON.stringify(
                predictionHistory,
                null,
                2
            ),
            "utf8"
        );
    } catch (error) {
        console.error(
            "SAVE ERROR:",
            error.message
        );
    }
}

/*
|--------------------------------------------------------------------------
| SOURCE API
|--------------------------------------------------------------------------
*/

async function fetchSource() {
    const response =
        await fetch(
            SOURCE_API,
            {
                headers: {
                    Accept:
                        "application/json",
                    "User-Agent":
                        "Mozilla/5.0"
                }
            }
        );

    if (!response.ok) {
        throw new Error(
            `SOURCE HTTP ${response.status}`
        );
    }

    const data =
        await response.json();

    if (
        !data ||
        !Array.isArray(data.list)
    ) {
        throw new Error(
            "Source API không có list"
        );
    }

    return data.list
        .map(item => ({
            phien:
                Number(item.id),

            xuc_xac:
                Array.isArray(
                    item.dices
                )
                    ? item.dices.map(
                          Number
                      )
                    : [],

            tong:
                Number(item.point),

            ket_qua:
                String(
                    item.resultTruyenThong
                ).toUpperCase() ===
                "TAI"
                    ? "Tài"
                    : "Xỉu"
        }))
        .filter(item =>
            Number.isFinite(
                item.phien
            ) &&
            item.xuc_xac.length ===
                3 &&
            item.xuc_xac.every(
                Number.isFinite
            ) &&
            Number.isFinite(
                item.tong
            )
        )
        .sort(
            (a, b) =>
                a.phien - b.phien
        )
        .slice(
            -MAX_SOURCE_HISTORY
        );
}

/*
|--------------------------------------------------------------------------
| PATTERN HISTORY
|--------------------------------------------------------------------------
*/

function buildPattern(history) {
    return history
        .slice(
            -MAX_PATTERN_HISTORY
        )
        .map(item =>
            tx(item.ket_qua)
        )
        .join("");
}

function getValues(history) {
    return history.map(item =>
        tx(item.ket_qua)
    );
}

/*
|--------------------------------------------------------------------------
| BAYESIAN CONFIDENCE
|--------------------------------------------------------------------------
|
| Không cho pattern 1/1 = 100%.
|
| alpha/beta = prior.
|--------------------------------------------------------------------------
*/

function bayesianRate(
    success,
    total
) {
    const alpha = 2;
    const beta = 2;

    return (
        (success + alpha) /
        (total + alpha + beta)
    );
}

function confidenceFromDistribution(
    tai,
    xiu,
    total
) {
    if (total <= 0) {
        return 50;
    }

    const pT =
        bayesianRate(
            tai,
            total
        );

    const pX =
        bayesianRate(
            xiu,
            total
        );

    const maxP =
        Math.max(pT, pX);

    const confidence =
        maxP * 100;

    return Number(
        clamp(
            confidence,
            50,
            97
        ).toFixed(2)
    );
}

/*
|--------------------------------------------------------------------------
| PATTERN EXACT MATCH
|--------------------------------------------------------------------------
*/

function findPatternMatches(
    history,
    pattern
) {
    const values =
        getValues(history);

    const matches = [];

    for (
        let i = 0;
        i + pattern.length <
        values.length;
        i++
    ) {
        const current =
            values
                .slice(
                    i,
                    i + pattern.length
                )
                .join("");

        if (
            current !== pattern
        ) {
            continue;
        }

        const next =
            values[
                i + pattern.length
            ];

        matches.push({
            index: i,
            next
        });
    }

    return matches;
}

function analyzeExactPattern(
    history,
    pattern
) {
    const matches =
        findPatternMatches(
            history,
            pattern
        );

    let tai = 0;
    let xiu = 0;

    for (
        const match of matches
    ) {
        if (
            match.next === "T"
        ) {
            tai++;
        } else {
            xiu++;
        }
    }

    const total =
        tai + xiu;

    if (!total) {
        return null;
    }

    const pT =
        bayesianRate(
            tai,
            total
        );

    const pX =
        bayesianRate(
            xiu,
            total
        );

    return {
        pattern,
        total,
        tai,
        xiu,
        pT,
        pX,
        rawTai:
            total
                ? tai / total
                : 0,
        rawXiu:
            total
                ? xiu / total
                : 0,
        confidence:
            confidenceFromDistribution(
                tai,
                xiu,
                total
            )
    };
}

/*
|--------------------------------------------------------------------------
| PATTERN CHÍNH
|--------------------------------------------------------------------------
*/

function analyzeMainPattern(
    history
) {
    const values =
        getValues(history);

    const max =
        Math.min(
            MAX_ANALYZE_PATTERN,
            values.length - 1
        );

    const all = [];

    for (
        let length = 2;
        length <= max;
        length++
    ) {
        const pattern =
            values
                .slice(-length)
                .join("");

        const data =
            analyzeExactPattern(
                history,
                pattern
            );

        if (data) {
            all.push({
                ...data,
                length,
                isCurrent: true
            });
        }
    }

    if (!all.length) {
        return {
            pattern: "",
            total: 0,
            tai: 0,
            xiu: 0,
            confidence: 50,
            prediction: null,
            samples: []
        };
    }

    /*
     * Pattern dài hơn được ưu tiên,
     * nhưng phải có đủ mẫu.
     */
    all.sort(
        (a, b) => {
            const scoreA =
                a.length *
                1.4 +
                Math.log2(
                    a.total + 1
                ) *
                    1.8;

            const scoreB =
                b.length *
                1.4 +
                Math.log2(
                    b.total + 1
                ) *
                    1.8;

            return scoreB - scoreA;
        }
    );

    const best =
        all[0];

    const prediction =
        best.pT >= best.pX
            ? "T"
            : "X";

    return {
        ...best,

        prediction,

        samples:
            all.slice(
                0,
                10
            )
    };
}

/*
|--------------------------------------------------------------------------
| SIMILAR PATTERN
|--------------------------------------------------------------------------
*/

function similarity(
    a,
    b
) {
    if (
        a.length !==
        b.length
    ) {
        return 0;
    }

    let same = 0;

    for (
        let i = 0;
        i < a.length;
        i++
    ) {
        if (
            a[i] === b[i]
        ) {
            same++;
        }
    }

    return (
        same / a.length
    );
}

function findSimilarPatterns(
    history,
    currentPattern
) {
    const values =
        getValues(history);

    const output = [];

    const length =
        currentPattern.length;

    if (length < 3) {
        return output;
    }

    for (
        let i = 0;
        i + length <
        values.length;
        i++
    ) {
        const candidate =
            values
                .slice(
                    i,
                    i + length
                )
                .join("");

        const score =
            similarity(
                currentPattern,
                candidate
            );

        if (
            score < 0.75
        ) {
            continue;
        }

        const next =
            values[
                i + length
            ];

        output.push({
            pattern:
                candidate,

            similarity:
                score,

            next,

            index: i
        });
    }

    let tai = 0;
    let xiu = 0;

    for (
        const item of output
    ) {
        const weight =
            Math.pow(
                item.similarity,
                3
            );

        if (
            item.next === "T"
        ) {
            tai += weight;
        } else {
            xiu += weight;
        }
    }

    const total =
        tai + xiu;

    return {
        matches:
            output.length,

        tai,
        xiu,

        total,

        pT:
            total
                ? tai / total
                : 0.5,

        pX:
            total
                ? xiu / total
                : 0.5,

        confidence:
            total
                ? confidenceFromDistribution(
                      tai,
                      xiu,
                      output.length
                  )
                : 50
    };
}

/*
|--------------------------------------------------------------------------
| PATTERN ĐẢO
|--------------------------------------------------------------------------
*/

function analyzeInversePattern(
    history,
    mainPattern
) {
    if (!mainPattern) {
        return null;
    }

    const inverse =
        invertPattern(
            mainPattern
        );

    const data =
        analyzeExactPattern(
            history,
            inverse
        );

    if (!data) {
        return null;
    }

    return {
        ...data,
        inverse
    };
}

/*
|--------------------------------------------------------------------------
| RUN / CẦU
|--------------------------------------------------------------------------
*/

function getRuns(history) {
    const values =
        getValues(history);

    const runs = [];

    if (!values.length) {
        return runs;
    }

    let side =
        values[0];

    let count = 1;

    for (
        let i = 1;
        i < values.length;
        i++
    ) {
        if (
            values[i] ===
            side
        ) {
            count++;
        } else {
            runs.push({
                side,
                count
            });

            side =
                values[i];

            count = 1;
        }
    }

    runs.push({
        side,
        count
    });

    return runs;
}

function runSignature(history) {
    return getRuns(history)
        .slice(-6)
        .map(run =>
            run.count
        )
        .join("-");
}

function analyzeRunPattern(
    history
) {
    const runs =
        getRuns(history);

    if (
        runs.length < 2
    ) {
        return null;
    }

    const recent =
        runs.slice(-8);

    const lengths =
        recent.map(
            r => r.count
        );

    const last =
        recent[
            recent.length - 1
        ];

    const previous =
        recent[
            recent.length - 2
        ];

    const result = [];

    function add(
        name,
        prediction,
        weight
    ) {
        result.push({
            name,
            prediction,
            weight
        });
    }

    /*
     * 1-1
     */
    if (
        lengths
            .slice(-6)
            .every(v => v === 1)
    ) {
        add(
            "1-1",
            opposite(last.side),
            0.90
        );
    }

    /*
     * 2-2
     */
    if (
        lengths.length >= 4 &&
        lengths
            .slice(-4)
            .every(v => v === 2)
    ) {
        add(
            "2-2",
            opposite(last.side),
            0.88
        );
    }

    /*
     * 3-3
     */
    if (
        lengths.length >= 4 &&
        lengths
            .slice(-4)
            .every(v => v === 3)
    ) {
        add(
            "3-3",
            opposite(last.side),
            0.86
        );
    }

    /*
     * 1-2-1
     */
    if (
        lengths
            .slice(-3)
            .join("-") ===
        "1-2-1"
    ) {
        add(
            "1-2-1",
            opposite(last.side),
            0.84
        );
    }

    /*
     * 2-1-2
     */
    if (
        lengths
            .slice(-3)
            .join("-") ===
        "2-1-2"
    ) {
        add(
            "2-1-2",
            opposite(last.side),
            0.84
        );
    }

    /*
     * 1-3-1
     */
    if (
        lengths
            .slice(-3)
            .join("-") ===
        "1-3-1"
    ) {
        add(
            "1-3-1",
            opposite(last.side),
            0.82
        );
    }

    /*
     * 3-1-3
     */
    if (
        lengths
            .slice(-3)
            .join("-") ===
        "3-1-3"
    ) {
        add(
            "3-1-3",
            opposite(last.side),
            0.82
        );
    }

    /*
     * 1-2
     */
    if (
        lengths
            .slice(-4)
            .join("-") ===
        "1-2-1-2"
    ) {
        add(
            "1-2",
            opposite(last.side),
            0.83
        );
    }

    /*
     * 2-1
     */
    if (
        lengths
            .slice(-4)
            .join("-") ===
        "2-1-2-1"
    ) {
        add(
            "2-1",
            opposite(last.side),
            0.83
        );
    }

    /*
     * 2-2-2
     */
    if (
        lengths
            .slice(-3)
            .join("-") ===
        "2-2-2"
    ) {
        add(
            "2-2-2",
            opposite(last.side),
            0.86
        );
    }

    /*
     * 3-2-1
     */
    if (
        lengths
            .slice(-3)
            .join("-") ===
        "3-2-1"
    ) {
        add(
            "3-2-1",
            opposite(last.side),
            0.78
        );
    }

    /*
     * 1-2-3
     */
    if (
        lengths
            .slice(-3)
            .join("-") ===
        "1-2-3"
    ) {
        add(
            "1-2-3",
            opposite(last.side),
            0.78
        );
    }

    /*
     * 4-1
     */
    if (
        lengths
            .slice(-2)
            .join("-") ===
        "4-1"
    ) {
        add(
            "4-1",
            opposite(last.side),
            0.76
        );
    }

    /*
     * 1-4
     */
    if (
        lengths
            .slice(-2)
            .join("-") ===
        "1-4"
    ) {
        add(
            "1-4",
            opposite(last.side),
            0.76
        );
    }

    /*
     * 5-1
     */
    if (
        lengths
            .slice(-2)
            .join("-") ===
        "5-1"
    ) {
        add(
            "5-1",
            opposite(last.side),
            0.74
        );
    }

    /*
     * 1-5
     */
    if (
        lengths
            .slice(-2)
            .join("-") ===
        "1-5"
    ) {
        add(
            "1-5",
            opposite(last.side),
            0.74
        );
    }

    /*
     * Cầu bệt
     */
    if (
        last.count >= 3
    ) {
        add(
            "bet",
            last.side,
            clamp(
                0.62 +
                    last.count *
                        0.04,
                0.62,
                0.82
            )
        );
    }

    /*
     * Cầu gãy
     */
    if (
        previous.count >= 3 &&
        last.count === 1
    ) {
        add(
            "gay",
            last.side,
            0.72
        );
    }

    return {
        signature:
            runSignature(
                history
            ),

        runs: recent,

        signals: result
    };
}

/*
|--------------------------------------------------------------------------
| CHU KỲ
|--------------------------------------------------------------------------
*/

function analyzeCycles(history) {
    const values =
        getValues(history);

    const signals = [];

    for (
        let period = 2;
        period <= 6;
        period++
    ) {
        if (
            values.length <
            period * 3
        ) {
            continue;
        }

        const recent =
            values.slice(
                -period
            );

        let matches = 0;

        let total = 0;

        for (
            let i = period;
            i < values.length;
            i++
        ) {
            const previous =
                values.slice(
                    i - period,
                    i
                );

            const current =
                values[i];

            if (
                previous.join("") ===
                recent.join("")
            ) {
                total++;

                if (
                    current ===
                    recent[
                        recent.length -
                            1
                    ]
                ) {
                    matches++;
                }
            }
        }

        if (total < 2) {
            continue;
        }

        const p =
            matches /
            total;

        const prediction =
            p >= 0.5
                ? recent[
                      recent.length - 1
                  ]
                : opposite(
                      recent[
                          recent.length -
                              1
                      ]
                  );

        signals.push({
            period,
            total,
            p,
            prediction
        });
    }

    return signals;
}

/*
|--------------------------------------------------------------------------
| MARKOV 1
|--------------------------------------------------------------------------
*/

function analyzeMarkov1(
    history
) {
    const values =
        getValues(history);

    if (
        values.length < 5
    ) {
        return null;
    }

    const current =
        values[
            values.length - 1
        ];

    let tai = 0;
    let xiu = 0;

    for (
        let i = 0;
        i < values.length - 1;
        i++
    ) {
        if (
            values[i] !==
            current
        ) {
            continue;
        }

        if (
            values[i + 1] ===
            "T"
        ) {
            tai++;
        } else {
            xiu++;
        }
    }

    const total =
        tai + xiu;

    if (!total) {
        return null;
    }

    return {
        tai,
        xiu,
        total,

        pT:
            bayesianRate(
                tai,
                total
            ),

        pX:
            bayesianRate(
                xiu,
                total
            )
    };
}

/*
|--------------------------------------------------------------------------
| MARKOV 2
|--------------------------------------------------------------------------
*/

function analyzeMarkov2(
    history
) {
    const values =
        getValues(history);

    if (
        values.length < 7
    ) {
        return null;
    }

    const key =
        values
            .slice(-2)
            .join("");

    let tai = 0;
    let xiu = 0;

    for (
        let i = 0;
        i < values.length - 2;
        i++
    ) {
        const pair =
            values
                .slice(
                    i,
                    i + 2
                )
                .join("");

        if (
            pair !== key
        ) {
            continue;
        }

        if (
            values[i + 2] ===
            "T"
        ) {
            tai++;
        } else {
            xiu++;
        }
    }

    const total =
        tai + xiu;

    if (!total) {
        return null;
    }

    return {
        key,
        tai,
        xiu,
        total,

        pT:
            bayesianRate(
                tai,
                total
            ),

        pX:
            bayesianRate(
                xiu,
                total
            )
    };
}

/*
|--------------------------------------------------------------------------
| ENSEMBLE
|--------------------------------------------------------------------------
*/

function calculatePrediction(
    history
) {
    const main =
        analyzeMainPattern(
            history
        );

    const inverse =
        analyzeInversePattern(
            history,
            main.pattern
        );

    const similar =
        findSimilarPatterns(
            history,
            main.pattern
        );

    const run =
        analyzeRunPattern(
            history
        );

    const cycles =
        analyzeCycles(
            history
        );

    const markov1 =
        analyzeMarkov1(
            history
        );

    const markov2 =
        analyzeMarkov2(
            history
        );

    const score = {
        T: 0,
        X: 0
    };

    const signals = [];

    /*
     * PATTERN CHÍNH
     *
     * Đây là tín hiệu quan trọng nhất.
     */
    if (
        main.total > 0
    ) {
        const weight =
            clamp(
                3 +
                    main.length *
                        0.45 +
                    Math.log2(
                        main.total + 1
                    ),
                3,
                9
            );

        score.T +=
            main.pT * weight;

        score.X +=
            main.pX * weight;

        signals.push({
            type:
                "pattern_chinh",

            pattern:
                main.pattern,

            length:
                main.length,

            samples:
                main.total,

            tai:
                main.tai,

            xiu:
                main.xiu,

            ty_le_tai:
                Number(
                    (
                        main.rawTai *
                        100
                    ).toFixed(2)
                ),

            ty_le_xiu:
                Number(
                    (
                        main.rawXiu *
                        100
                    ).toFixed(2)
                ),

            bayes_tai:
                Number(
                    (
                        main.pT *
                        100
                    ).toFixed(2)
                ),

            bayes_xiu:
                Number(
                    (
                        main.pX *
                        100
                    ).toFixed(2)
                ),

            do_tin_cay:
                `${main.confidence}%`,

            weight
        });
    }

    /*
     * PATTERN ĐẢO
     */
    if (inverse) {
        const weight =
            1.5;

        score.T +=
            inverse.pT *
            weight;

        score.X +=
            inverse.pX *
            weight;

        signals.push({
            type:
                "pattern_dao",

            pattern:
                inverse.inverse,

            samples:
                inverse.total,

            tai:
                inverse.tai,

            xiu:
                inverse.xiu,

            weight
        });
    }

    /*
     * PATTERN TƯƠNG TỰ
     */
    if (
        similar &&
        similar.total > 0
    ) {
        const weight =
            clamp(
                1.5 +
                    similar.matches *
                        0.12,
                1.5,
                3
            );

        score.T +=
            similar.pT *
            weight;

        score.X +=
            similar.pX *
            weight;

        signals.push({
            type:
                "pattern_tuong_tu",

            matches:
                similar.matches,

            tai:
                Number(
                    (
                        similar.pT *
                        100
                    ).toFixed(2)
                ),

            xiu:
                Number(
                    (
                        similar.pX *
                        100
                    ).toFixed(2)
                ),

            weight
        });
    }

    /*
     * MARKOV 1
     */
    if (markov1) {
        const weight = 2;

        score.T +=
            markov1.pT *
            weight;

        score.X +=
            markov1.pX *
            weight;

        signals.push({
            type:
                "markov_1",

            samples:
                markov1.total,

            tai:
                markov1.tai,

            xiu:
                markov1.xiu,

            weight
        });
    }

    /*
     * MARKOV 2
     */
    if (markov2) {
        const weight = 2.5;

        score.T +=
            markov2.pT *
            weight;

        score.X +=
            markov2.pX *
            weight;

        signals.push({
            type:
                "markov_2",

            pattern:
                markov2.key,

            samples:
                markov2.total,

            tai:
                markov2.tai,

            xiu:
                markov2.xiu,

            weight
        });
    }

    /*
     * RUN
     */
    if (
        run &&
        run.signals.length
    ) {
        for (
            const signal
            of run.signals
        ) {
            score[
                signal.prediction
            ] +=
                signal.weight * 1.7;

            signals.push({
                type:
                    "run",

                pattern:
                    signal.name,

                prediction:
                    result(
                        signal.prediction
                    ),

                strength:
                    signal.weight
            });
        }
    }

    /*
     * CYCLE
     */
    for (
        const cycle
        of cycles
    ) {
        const weight =
            clamp(
                0.8 +
                    cycle.total *
                        0.08,
                0.8,
                1.8
            );

        score[
            cycle.prediction
        ] += weight;

        signals.push({
            type:
                "cycle",

            period:
                cycle.period,

            samples:
                cycle.total,

            prediction:
                result(
                    cycle.prediction
                ),

            weight
        });
    }

    /*
     * FINAL
     */
    const total =
        score.T +
        score.X;

    if (!total) {
        return {
            du_doan:
                "Không rõ cầu",

            side: null,

            do_tin_cay:
                "50.00%",

            confidence: 50,

            pattern_chinh:
                main,

            signals
        };
    }

    const side =
        score.T >= score.X
            ? "T"
            : "X";

    /*
     * Độ đồng thuận.
     */
    const votes = {
        T: 0,
        X: 0
    };

    for (
        const signal
        of signals
    ) {
        let prediction = null;

        if (
            signal.type ===
            "pattern_chinh"
        ) {
            prediction =
                main.prediction;
        }

        if (
            signal.type ===
            "pattern_dao"
        ) {
            prediction =
                inverse.pT >=
                inverse.pX
                    ? "T"
                    : "X";
        }

        if (
            signal.type ===
            "pattern_tuong_tu"
        ) {
            prediction =
                similar.pT >=
                similar.pX
                    ? "T"
                    : "X";
        }

        if (
            signal.type ===
            "markov_1"
        ) {
            prediction =
                markov1.pT >=
                markov1.pX
                    ? "T"
                    : "X";
        }

        if (
            signal.type ===
            "markov_2"
        ) {
            prediction =
                markov2.pT >=
                markov2.pX
                    ? "T"
                    : "X";
        }

        if (
            signal.type ===
            "run"
        ) {
            prediction =
                signal.prediction;
        }

        if (
            signal.type ===
            "cycle"
        ) {
            prediction =
                signal.prediction;
        }

        if (prediction) {
            votes[prediction]++;
        }
    }

    const voteTotal =
        votes.T +
        votes.X;

    const agreement =
        voteTotal
            ? Math.max(
                  votes.T,
                  votes.X
              ) /
              voteTotal
            : 0.5;

    /*
     * Confidence ensemble:
     *
     * 55% score model
     * 30% pattern chính
     * 15% đồng thuận
     */
    const scoreConfidence =
        Math.max(
            score.T,
            score.X
        ) / total;

    const mainConfidence =
        main.total > 0
            ? Math.max(
                  main.pT,
                  main.pX
              )
            : 0.5;

    let confidence =
        (
            scoreConfidence *
                0.55 +
            mainConfidence *
                0.30 +
            agreement *
                0.15
        ) * 100;

    /*
     * Không cho confidence cao nếu
     * pattern chính có quá ít dữ liệu.
     */
    if (
        main.total === 0
    ) {
        confidence =
            Math.min(
                confidence,
                65
            );
    } else if (
        main.total < 3
    ) {
        confidence =
            Math.min(
                confidence,
                68
            );
    } else if (
        main.total < 5
    ) {
        confidence =
            Math.min(
                confidence,
                75
            );
    } else if (
        main.total < 8
    ) {
        confidence =
            Math.min(
                confidence,
                84
            );
    }

    /*
     * Nếu mô hình chia rất sát nhau
     * thì giảm confidence.
     */
    const margin =
        Math.abs(
            score.T -
                score.X
        ) / total;

    if (
        margin < 0.08
    ) {
        confidence -= 8;
    } else if (
        margin < 0.15
    ) {
        confidence -= 4;
    }

    confidence =
        clamp(
            confidence,
            50,
            97
        );

    confidence =
        Number(
            confidence.toFixed(2)
        );

    return {
        du_doan:
            result(side),

        side,

        do_tin_cay:
            `${confidence.toFixed(2)}%`,

        confidence,

        score: {
            tai:
                Number(
                    score.T.toFixed(4)
                ),

            xiu:
                Number(
                    score.X.toFixed(4)
                )
        },

        agreement:
            Number(
                (
                    agreement * 100
                ).toFixed(2)
            ),

        votes,

        pattern_chinh: {
            pattern:
                main.pattern,

            length:
                main.length,

            so_lan_gap:
                main.total,

            tai_sau_pattern:
                main.tai,

            xiu_sau_pattern:
                main.xiu,

            ty_le_tai:
                Number(
                    (
                        main.rawTai *
                        100
                    ).toFixed(2)
                ),

            ty_le_xiu:
                Number(
                    (
                        main.rawXiu *
                        100
                    ).toFixed(2)
                ),

            bayes_tai:
                Number(
                    (
                        main.pT *
                        100
                    ).toFixed(2)
                ),

            bayes_xiu:
                Number(
                    (
                        main.pX *
                        100
                    ).toFixed(2)
                ),

            du_doan:
                main.prediction
                    ? result(
                          main.prediction
                      )
                    : "Không rõ",

            do_tin_cay:
                `${main.confidence}%`
        },

        signals
    };
}

/*
|--------------------------------------------------------------------------
| UPDATE PREDICTION HISTORY
|--------------------------------------------------------------------------
*/

function updatePredictionResults(
    sourceHistory
) {
    let changed = false;

    for (
        const prediction
        of predictionHistory
    ) {
        if (
            prediction.ket_qua !==
            "⌛ Chờ Kết Quả"
        ) {
            continue;
        }

        const actual =
            sourceHistory.find(
                item =>
                    Number(
                        item.phien
                    ) ===
                    Number(
                        prediction.phien
                    )
            );

        if (!actual) {
            continue;
        }

        prediction.ket_qua =
            actual.ket_qua;

        prediction.xuc_xac =
            actual.xuc_xac;

        prediction.tong =
            actual.tong;

        prediction.danh_gia =
            prediction.du_doan ===
            actual.ket_qua
                ? "✅ Thắng"
                : "❌ Thua";

        changed = true;
    }

    if (changed) {
        savePredictions();
    }
}

/*
|--------------------------------------------------------------------------
| SELF LEARNING
|--------------------------------------------------------------------------
*/

const learned = new Map();

function learnPattern(
    pattern,
    won
) {
    if (!pattern) {
        return;
    }

    if (
        !learned.has(
            pattern
        )
    ) {
        learned.set(
            pattern,
            {
                total: 0,
                win: 0,
                lose: 0
            }
        );
    }

    const data =
        learned.get(pattern);

    data.total++;

    if (won) {
        data.win++;
    } else {
        data.lose++;
    }
}

function rebuildLearning() {
    learned.clear();

    for (
        const item
        of predictionHistory
    ) {
        if (
            item.danh_gia !==
            "✅ Thắng" &&
            item.danh_gia !==
            "❌ Thua"
        ) {
            continue;
        }

        learnPattern(
            item.pattern,
            item.danh_gia ===
                "✅ Thắng"
        );
    }
}

/*
|--------------------------------------------------------------------------
| CREATE NEXT PREDICTION
|--------------------------------------------------------------------------
*/

function createNextPrediction(
    history,
    analysis,
    pattern
) {
    const latest =
        history[
            history.length - 1
        ];

    const nextPhien =
        latest.phien + 1;

    let record =
        predictionHistory.find(
            item =>
                Number(
                    item.phien
                ) ===
                Number(nextPhien)
        );

    if (!record) {
        record = {
            phien:
                nextPhien,

            du_doan:
                analysis.du_doan,

            do_tin_cay:
                analysis.do_tin_cay,

            ket_qua:
                "⌛ Chờ Kết Quả",

            danh_gia:
                "⌛ Chờ",

            xuc_xac: [],

            tong:
                "⌛ Chờ",

            pattern,

            created_at:
                new Date().toISOString()
        };

        predictionHistory.push(
            record
        );
    } else {
        record.du_doan =
            analysis.du_doan;

        record.do_tin_cay =
            analysis.do_tin_cay;

        record.pattern =
            pattern;
    }

    predictionHistory =
        predictionHistory
            .sort(
                (a, b) =>
                    Number(a.phien) -
                    Number(b.phien)
            )
            .slice(
                -MAX_PREDICTION_HISTORY
            );

    savePredictions();

    return record;
}

/*
|--------------------------------------------------------------------------
| MAIN DATA
|--------------------------------------------------------------------------
*/

async function getData() {
    const now =
        Date.now();

    if (
        cache.prediction &&
        now - cache.time <
            CACHE_MS
    ) {
        return cache;
    }

    const history =
        await fetchSource();

    updatePredictionResults(
        history
    );

    rebuildLearning();

    const pattern =
        buildPattern(
            history
        );

    const prediction =
        calculatePrediction(
            history
        );

    const next =
        createNextPrediction(
            history,
            prediction,
            pattern
        );

    cache = {
        time: now,

        history,

        pattern,

        prediction,

        next
    };

    return cache;
}

/*
|--------------------------------------------------------------------------
| API /api/taixiumd5
|--------------------------------------------------------------------------
*/

app.get(
    "/api/taixiumd5",
    async (req, res) => {
        try {
            const {
                history,
                pattern,
                prediction,
                next
            } = await getData();

            const latest =
                history[
                    history.length - 1
                ];

            res.json({
                phien:
                    latest.phien,

                xuc_xac:
                    latest.xuc_xac,

                tong:
                    latest.tong,

                ket_qua:
                    latest.ket_qua,

                phien_hien_tai:
                    latest.phien + 1,

                pattern,

                du_doan:
                    prediction.du_doan,

                do_tin_cay:
                    prediction.do_tin_cay
            });
        } catch (error) {
            console.error(
                "TAIXIUMD5:",
                error.message
            );

            res.status(500).json({
                error:
                    error.message
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| API /api/taixiumd5/detail
|--------------------------------------------------------------------------
*/

app.get(
    "/api/taixiumd5/detail",
    async (req, res) => {
        try {
            const {
                history,
                pattern,
                prediction,
                next
            } = await getData();

            const latest =
                history[
                    history.length - 1
                ];

            res.json({
                phien:
                    latest.phien,

                xuc_xac:
                    latest.xuc_xac,

                tong:
                    latest.tong,

                ket_qua:
                    latest.ket_qua,

                phien_hien_tai:
                    latest.phien + 1,

                pattern,

                pattern_length:
                    pattern.length,

                du_doan:
                    prediction.du_doan,

                do_tin_cay:
                    prediction.do_tin_cay,

                pattern_chinh:
                    prediction.pattern_chinh,

                score:
                    prediction.score,

                agreement:
                    prediction.agreement,

                votes:
                    prediction.votes,

                signals:
                    prediction.signals,

                next_prediction:
                    next,

                history:
                    history.slice(
                        -MAX_PATTERN_HISTORY
                    )
            });
        } catch (error) {
            res.status(500).json({
                error:
                    error.message
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| API /api/txmd5/history
|--------------------------------------------------------------------------
*/

app.get(
    "/api/txmd5/history",
    async (req, res) => {
        try {
            const {
                history,
                next
            } = await getData();

            updatePredictionResults(
                history
            );

            rebuildLearning();

            const output =
                predictionHistory
                    .slice()
                    .sort(
                        (a, b) =>
                            Number(b.phien) -
                            Number(a.phien)
                    )
                    .slice(
                        0,
                        MAX_PREDICTION_HISTORY
                    )
                    .map(item => ({
                        phien:
                            item.phien,

                        du_doan:
                            item.du_doan,

                        ket_qua:
                            item.ket_qua,

                        danh_gia:
                            item.danh_gia,

                        xuc_xac:
                            item.xuc_xac,

                        tong:
                            item.tong
                    }));

            const exists =
                output.some(
                    item =>
                        Number(
                            item.phien
                        ) ===
                        Number(
                            next.phien
                        )
                );

            if (!exists) {
                output.unshift({
                    phien:
                        next.phien,

                    du_doan:
                        next.du_doan,

                    ket_qua:
                        "⌛ Chờ Kết Quả",

                    danh_gia:
                        "⌛ Chờ",

                    xuc_xac: [],

                    tong:
                        "⌛ Chờ"
                });
            }

            res.json(
                output.slice(
                    0,
                    MAX_PREDICTION_HISTORY
                )
            );
        } catch (error) {
            console.error(
                "HISTORY:",
                error.message
            );

            res.status(500).json({
                error:
                    error.message
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| API /api/txmd5/learning
|--------------------------------------------------------------------------
*/

app.get(
    "/api/txmd5/learning",
    (req, res) => {
        rebuildLearning();

        const patterns = {};

        for (
            const [
                pattern,
                data
            ]
            of learned
        ) {
            const winRate =
                data.total > 0
                    ? (
                          data.win /
                          data.total
                      ) * 100
                    : 0;

            patterns[
                pattern
            ] = {
                total:
                    data.total,

                win:
                    data.win,

                lose:
                    data.lose,

                win_rate:
                    Number(
                        winRate.toFixed(
                            2
                        )
                    )
            };
        }

        res.json({
            total_patterns:
                Object.keys(
                    patterns
                ).length,

            patterns
        });
    }
);

/*
|--------------------------------------------------------------------------
| API /api/txmd5/pattern
|--------------------------------------------------------------------------
*/

app.get(
    "/api/txmd5/pattern",
    async (req, res) => {
        try {
            const {
                history,
                pattern,
                prediction
            } = await getData();

            res.json({
                pattern,

                length:
                    pattern.length,

                cu_ben_trai:
                    true,

                moi_ben_phai:
                    true,

                pattern_chinh:
                    prediction.pattern_chinh,

                du_doan:
                    prediction.du_doan,

                do_tin_cay:
                    prediction.do_tin_cay,

                history:
                    history.slice(
                        -MAX_PATTERN_HISTORY
                    )
            });
        } catch (error) {
            res.status(500).json({
                error:
                    error.message
            });
        }
    }
);

/*
|--------------------------------------------------------------------------
| HEALTH
|--------------------------------------------------------------------------
*/

app.get(
    "/",
    (req, res) => {
        res.json({
            status:
                "online",

            service:
                "TAI XIU MD5",

            pattern:
                "20 phiên - cũ trái, mới phải",

            endpoints: [
                "/api/taixiumd5",
                "/api/taixiumd5/detail",
                "/api/txmd5/history",
                "/api/txmd5/pattern",
                "/api/txmd5/learning"
            ]
        });
    }
);

/*
|--------------------------------------------------------------------------
| AUTO UPDATE
|--------------------------------------------------------------------------
*/

setInterval(
    async () => {
        try {
            await getData();
        } catch (error) {
            console.error(
                "AUTO UPDATE:",
                error.message
            );
        }
    },
    CACHE_MS
);

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

app.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            `TAI XIU MD5 API running :${PORT}`
        );

        console.log(
            `SOURCE: ${SOURCE_API}`
        );

        console.log(
            `PATTERN: ${MAX_PATTERN_HISTORY} phiên`
        );
    }
);
