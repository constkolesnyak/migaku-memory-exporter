// ==UserScript==
// @name        Migaku Memory Exporter
// @namespace   Violentmonkey Scripts
// @match       https://study.migaku.com/*
// @grant       GM_getResourceURL
// @version     1.5
// @author      -
// @description 29/05/2025, 13:09:19
// @require      data:application/javascript,%3BglobalThis.setImmediate%3DsetTimeout%3B
// @require https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/sql-wasm.js
// @resource sql_wasm https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/sql-wasm.wasm
// @require https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// ==/UserScript==

// Original: https://github.com/SirOlaf/migaku-anki-exporter/blob/main/inject_mm_exporter.js

const statusMessageElemId = 'mgkexporterStatusMessage';
const STORENAME_MEDIACACHE = 'mediacache';

const decompress = async (blob) => {
    const ds = new DecompressionStream('gzip');
    const decompressedStream = blob.stream().pipeThrough(ds);
    const reader = decompressedStream.getReader();
    const chunks = [];
    let totalSize = 0;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        totalSize += value.byteLength;
    }
    const res = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of chunks) {
        res.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return res;
};

const fetchFirebaseLocalStorageDbRows = () => {
    return new Promise((resolve) => {
        console.log('Fetching firebase database');
        const dbRequest = indexedDB.open('firebaseLocalStorageDb', 1);
        dbRequest.onsuccess = function (event) {
            const idb = dbRequest.result;
            const transaction = idb.transaction(
                'firebaseLocalStorage',
                'readonly'
            );
            const objectStore = transaction.objectStore('firebaseLocalStorage');
            objectStore.getAll().onsuccess = (event) => {
                resolve(event.target.result);
            };
            idb.close();
        };
    });
};

const fetchGoogleAuth = async (firebaseApiKey, refreshToken) => {
    const url = `https://securetoken.googleapis.com/v1/token?key=${firebaseApiKey}`;
    const resp = await fetch(url, {
        method: 'post',
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
        }),
    });
    return await resp.json();
};

const fetchAccessToken = async () => {
    const firebaseInfo = (await fetchFirebaseLocalStorageDbRows())[0].value;
    const auth = await fetchGoogleAuth(
        firebaseInfo.apiKey,
        firebaseInfo.stsTokenManager.refreshToken
    );
    let exp = Date.now() + (Number(auth.expires_in) - 5) * 1000;
    return { token: auth.access_token, expiresAt: exp };
};

const fetchRawSrsDb = () => {
    return new Promise((resolve) => {
        console.log('Fetching raw database');
        const dbRequest = indexedDB.open('srs', 1);
        dbRequest.onsuccess = function (event) {
            const idb = dbRequest.result;

            const transaction = idb.transaction('data', 'readonly');
            const objectStore = transaction.objectStore('data');

            const cursorRequest = objectStore.openCursor();
            cursorRequest.onsuccess = function (ev) {
                if (cursorRequest.result) {
                    const cursor = cursorRequest.result;
                    const data = cursor.value.data;

                    const blob = new Blob([data], {
                        type: 'application/octet-stream',
                    });
                    decompress(blob).then((decompressedDb) => {
                        resolve(decompressedDb);
                    });
                    cursor.continue();
                }
            };
            idb.close();
        };
    });
};

const fetchMigakuSrsMedia = async (path, auth) => {
    if (auth.expiresAt < Date.now()) {
        console.log('Refreshing auth token');
        const newAuth = await fetchAccessToken();
        auth.token = newAuth.token;
        auth.expiresAt = newAuth.expiresAt;
    }
    const baseUrl = 'https://file-sync-worker-api.migaku.com/data/';
    const url = baseUrl + path;
    const resp = await fetch(url, {
        headers: {
            Authorization: 'Bearer ' + auth.token,
        },
        cache: 'force-cache',
    });
    if (resp.status !== 200) return null;
    return await resp.blob();
};

const queryMigakuSelectedLanguage = () => {
    return document
        .querySelector('main.MIGAKU-SRS')
        .getAttribute('data-mgk-lang-selected');
};

const openSrsDb = (SQL) => {
    return new Promise((resolve) => {
        fetchRawSrsDb().then((raw) => {
            resolve(new SQL.Database(raw));
        });
    });
};

const openMediaChacheIdb = () => {
    return new Promise((resolve) => {
        const dbRequest = indexedDB.open('unofficialmgkexporterMediaDb', 1);
        dbRequest.onupgradeneeded = (ev) => {
            const idb = ev.target.result;
            if (!idb.objectStoreNames.contains(STORENAME_MEDIACACHE)) {
                idb.createObjectStore(STORENAME_MEDIACACHE, {
                    keyPath: 'key',
                    autoIncrement: false,
                });
            }
        };
        dbRequest.onsuccess = (ev) => {
            const idb = ev.target.result;
            resolve(idb);
        };
    });
};

const mediaCachePutBlob = (db, key, blob) => {
    return new Promise((resolve) => {
        db
            .transaction(STORENAME_MEDIACACHE, 'readwrite')
            .objectStore(STORENAME_MEDIACACHE)
            .add({ key: key, blob: blob }).onsuccess = (ev) => {
            resolve(ev.target.result);
        };
    });
};

const mediaCacheGetByKeyOrNull = (db, key) => {
    return new Promise((resolve) => {
        const req = db
            .transaction(STORENAME_MEDIACACHE, 'readonly')
            .objectStore(STORENAME_MEDIACACHE)
            .get(key);
        req.onsuccess = (ev) => {
            if (ev.target.result) {
                resolve(ev.target.result.blob);
            } else {
                resolve(null);
            }
        };
        req.onerror = (_) => {
            resolve(null);
        };
    });
};

const mediaCacheCheckHasKey = async (db, key) => {
    return (await mediaCacheGetByKeyOrNull(db, key)) !== null;
};

const convDbRowToObject = (columnNames, rowVals) => {
    const row = {};
    let i = 0;
    for (const colName of columnNames) {
        if (colName == 'del') {
            row[colName] = rowVals[i] !== 0;
        } else {
            row[colName] = rowVals[i];
        }
        i += 1;
    }
    return row;
};

const convDbRowsToObjectArray = (dbRes) => {
    const res = [];
    for (const val of dbRes.values) {
        res.push(convDbRowToObject(dbRes.columns, val));
    }
    return res;
};

const fetchDbRowsAsObjectArray = (db, query, args) => {
    return convDbRowsToObjectArray(db.exec(query, args)[0]);
};

const fetchDeckList = (db) => {
    return fetchDbRowsAsObjectArray(
        db,
        'SELECT id, lang, name, del FROM deck;'
    );
};

const fetchDeckCards = (db, deckId) => {
    return fetchDbRowsAsObjectArray(
        db,
        'SELECT id, mod, del, cardTypeId, created, primaryField, secondaryField, fields, words, due, interval, factor, lastReview, reviewCount, passCount, failCount, suspended FROM card WHERE deckId=?',
        [deckId]
    );
};

const fetchCardTypes = (db) => {
    let rows = fetchDbRowsAsObjectArray(
        db,
        'SELECT id, del, lang, name, config FROM card_type'
    );
    const res = new Map();
    for (const row of rows) {
        row.config = JSON.parse(row.config);
        res.set(row.id, row);
    }
    return res;
};

const fetchReviewHistory = (db) => {
    return fetchDbRowsAsObjectArray(
        db,
        'SELECT id, mod, del, day, interval, factor, cardId, duration, type, lapseIndex FROM review'
    );
};

const fetchWordListForLang = (db, lang) => {
    return fetchDbRowsAsObjectArray(
        db,
        'SELECT dictForm, secondary, partOfSpeech, language, mod, serverMod, del, knownStatus, hasCard, tracked FROM WordList WHERE language=?',
        [lang]
    );
};

const initNewAnkiSqlDb = (SQL) => {
    const db = new SQL.Database();
    db.run(`
        CREATE TABLE cards (
            id integer primary key,
            nid integer not null,
            did integer not null,
            ord integer not null,
            mod integer not null,
            usn integer not null,
            type integer not null,
            queue integer not null,
            due integer not null,
            ivl integer not null,
            factor integer not null,
            reps integer not null,
            lapses integer not null,
            left integer not null,
            odue integer not null,
            odid integer not null,
            flags integer not null,
            data text not null
        ) STRICT;
        CREATE TABLE col (
            id integer primary key,
            crt integer not null,
            mod integer not null,
            scm integer not null,
            ver integer not null,
            dty integer not null,
            usn integer not null,
            ls integer not null,
            conf text not null,
            models text not null,
            decks text not null,
            dconf text not null,
            tags text not null
        ) STRICT;
        CREATE TABLE graves (
            usn integer not null,
            oid integer not null,
            type integer not null
        ) STRICT;
        CREATE TABLE notes (
            id integer primary key,
            guid text not null,
            mid integer not null,
            mod integer not null,
            usn integer not null,
            tags text not null,
            flds text not null,
            sfld integer not null,
            csum integer not null,
            flags integer not null,
            data text not null
        ) STRICT;
        CREATE TABLE revlog (
            id integer primary key,
            cid integer not null,
            usn integer not null,
            ease integer not null,
            ivl integer not null,
            lastIvl integer not null,
            factor integer not null,
            time integer not null,
            type integer not null
        ) STRICT;
        CREATE INDEX ix_cards_nid on cards (nid);
        CREATE INDEX ix_cards_sched on cards (did, queue, due);
        CREATE INDEX ix_cards_usn on cards (usn);
        CREATE INDEX ix_notes_csum on notes (csum);
        CREATE INDEX ix_notes_usn on notes (usn);
        CREATE INDEX ix_revlog_cid on revlog (cid);
        CREATE INDEX ix_revlog_usn on revlog (usn);
    `);
    return db;
};

const ankiDbPutCol = (db, usedCardTypes) => {
    // TODO: Add fields for all the card types
    const cardTypeIdsToModelIds = new Map();
    usedCardTypes.forEach((x) => {
        if (!x) {
            window.alert('Bad card type entry');
            throw Error();
        }
        cardTypeIdsToModelIds.set(x.id, Date.now());
    });

    const conf = {
        curDeck: 1,
        curModel: cardTypeIdsToModelIds.get(usedCardTypes[0].id).toString(),
    };

    const models = {};
    for (const cardType of usedCardTypes) {
        const fields = [];
        const pushField = (name) => {
            fields.push({
                font: 'Arial',
                media: [],
                name: name,
                ord: fields.length,
                rtl: false,
                size: 20,
                sticky: false,
            });
        };

        let template = null;
        switch (cardType.name) {
            case 'Sentence':
                cardType.config.fields.forEach((x) => pushField(x.name));
                template = {
                    name: 'Basic',
                    qfmt: '{{Word}}<br>{{Sentence}}',
                    did: null,
                    bafmt: '',
                    afmt: `
                        {{FrontSide}}<hr id="answer"><br>
                        {{Sentence Audio}}<br>
                        {{Word Audio}}<br>
                        {{Translated Sentence}}<br>
                        <div>{{Definitions}}</div><br>
                        {{Images}}<br>
                        <div>{{Example Sentences}}</div><br>
                        <div>{{Notes}}</div>
                    `,
                    ord: 0,
                    bqfmt: '',
                };
                break;
            case 'Word':
            case 'Audio Sentence':
            case 'Audio Word':
            default:
                debugger;
                window.alert('Unimplemented card type: ' + cardType.toString());
                throw Error();
        }

        if (!template) {
            window.alert(
                'Internal error: Did not produce a card template for ' +
                    cardType.toString()
            );
            throw Error('Bad template');
        }

        models[cardTypeIdsToModelIds.get(cardType.id)] = {
            css: '',
            did: 1,
            flds: fields,
            id: cardTypeIdsToModelIds.get(cardType.id),
            latexPost: '',
            latexPre: '',
            mod: Math.floor(Date.now() / 1000),
            name: 'base',
            req: [], // unused
            sortf: 0,
            tags: [],
            tmpls: [template],
            type: 0, // standard
            usn: -1,
            vers: [],
        };
    }

    const decks = {
        1: {
            name: 'Default',
            extendRev: 10,
            usn: -1,
            collapsed: false,
            browserCollapsed: false,
            newToday: [0, 0],
            revToday: [0, 0],
            lrnToday: [0, 0],
            timeToday: [0, 0],
            dyn: 0,
            extendNew: 10,
            conf: 1,
            id: 1,
            mod: Date.now(),
            desc: '',
        },
    };

    const dconf = {
        1: {
            autoplay: false,
            id: 1,
            lapse: {
                delays: [10],
                leechAction: 0,
                leechFails: 8,
                minInt: 1,
                mult: 0,
            },
            maxTaken: 60,
            mod: 0,
            name: 'Default',
            new: {
                bury: true,
                delays: [1, 10],
                initialFactor: 2500,
                ints: [1, 4, 7],
                order: 1,
                perDay: 20,
                separate: true,
            },
            replayq: true,
            rev: {
                bury: true,
                ease4: 1.3,
                fuzz: 0.05,
                ivlFct: 1,
                maxIvl: 36500,
                minSpace: 1,
                perDay: 100,
            },
            timer: 0,
            usn: -1,
        },
    };

    db.run('INSERT INTO col VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        1, // id
        Math.floor(Date.now() / 1000), // crt
        Date.now(), // mod
        Date.now(), // scm
        11, // ver
        0, // dty
        0, // usn
        Date.now(), // ls
        JSON.stringify(conf), // conf
        JSON.stringify(models), // models
        JSON.stringify(decks), // decks
        JSON.stringify(dconf), // dconf
        '{}', // tags
    ]);
    return cardTypeIdsToModelIds;
};

const setStatus = (message) => {
    console.log(message);
    document.getElementById(statusMessageElemId).innerText = message;
};

const mediaCacheGatherAllMedia = async (
    mediacacheDb,
    cardsByCardType,
    cardTypes
) => {
    return new Promise(async (resolve, reject) => {
        const pathSet = new Set();
        setStatus('Preparing media paths');
        for (const typeKey of cardsByCardType.keys()) {
            const cardList = cardsByCardType.get(typeKey);
            const cardType = cardTypes.get(typeKey);
            const defCardFields = cardType.config.fields;
            for (const card of cardList) {
                let fieldIdx = 0;
                const handleField = (x) => {
                    if (fieldIdx >= defCardFields.length) return;
                    const fieldInfo = defCardFields[fieldIdx];
                    fieldIdx++;
                    switch (fieldInfo.type) {
                        case 'IMAGE':
                        case 'AUDIO':
                        case 'AUDIO_LONG':
                            if (x.trim().length === 0) return;
                            pathSet.add(x.slice(5));
                            break;
                        default:
                            break;
                    }
                };
                handleField(card.primaryField);
                handleField(card.secondaryField);
                for (const part of card.fields.split('\u001f')) {
                    handleField(part);
                }
            }
        }
        setStatus('Beginning media download');

        let dlCount = 0;
        let queue = Array.from(pathSet);
        const fullMediaCount = queue.length;
        let accessToken = await fetchAccessToken();
        let mediaMap = new Map();
        const workerProc = async () => {
            while (queue.length > 0) {
                const path = queue.shift();

                let extension = '.' + path.split('.').pop();
                if (extension.length >= 7) {
                    extension = '';
                }
                const zipPath =
                    Array.from(
                        new Uint8Array(
                            await window.crypto.subtle.digest(
                                'SHA-1',
                                new TextEncoder().encode(path)
                            )
                        )
                    )
                        .map((b) => b.toString(16).padStart(2, '0'))
                        .join('') + extension;

                if (await mediaCacheCheckHasKey(mediacacheDb, zipPath)) {
                    dlCount++;
                    setStatus(
                        `${dlCount}/${fullMediaCount}\n From cache ${path}`
                    );
                    mediaMap.set(path, zipPath);
                    continue;
                }
                console.log(`STARTING ${path}`);
                let blob = await fetchMigakuSrsMedia(path, accessToken);
                dlCount++;
                setStatus(`${dlCount}/${fullMediaCount}\n Downloaded ${path}`);
                if (!blob) {
                    continue;
                } else {
                    mediaCachePutBlob(mediacacheDb, zipPath, blob);
                    mediaMap.set(path, zipPath);
                }
            }
        };

        const workerCount = 5; // TODO: Can this be raised safely?
        let workerPromises = new Array();
        for (let i = 0; i < workerCount; i++) {
            workerPromises.push(workerProc());
        }
        Promise.all(workerPromises).then(
            () => {
                resolve(mediaMap);
            },
            () => {
                reject();
            }
        );
    });
};

const ankiDbFillCards = async (
    db,
    mediacacheDb,
    zipHandle,
    cardsByCardType,
    cardTypes,
    cardTypeIdsToModelIds,
    shouldIncludeMedia,
    keepSyntax
) => {
    const invertedMediaMap = new Map();
    let curMediaNum = 0;
    const zipMedia = async (dirtyPath) => {
        if (dirtyPath.trim().length === 0) return null;
        const path = dirtyPath.slice(5);
        let extension = '.' + path.split('.').pop();
        if (extension.length >= 7) {
            extension = '';
        }
        const zipPath =
            Array.from(
                new Uint8Array(
                    await window.crypto.subtle.digest(
                        'SHA-1',
                        new TextEncoder().encode(path)
                    )
                )
            )
                .map((b) => b.toString(16).padStart(2, '0'))
                .join('') + extension;
        if (!invertedMediaMap.has(zipPath)) {
            const mediaBlob = await mediaCacheGetByKeyOrNull(
                mediacacheDb,
                zipPath
            );
            if (!mediaBlob) {
                return null;
            } else {
                zipHandle.file(curMediaNum, mediaBlob);
                invertedMediaMap.set(zipPath, curMediaNum.toString());
                curMediaNum++;
            }
        }
        return zipPath;
    };

    setStatus('Converting cards');
    db.run('BEGIN TRANSACTION;');
    for (const typeKey of cardsByCardType.keys()) {
        const modelId = cardTypeIdsToModelIds.get(typeKey);
        const cardList = cardsByCardType.get(typeKey);
        const cardType = cardTypes.get(typeKey);
        const defCardFields = cardType.config.fields;
        let i = 0;
        for (const card of cardList) {
            const fieldsList = [];
            const pushField = async (x) => {
                const fieldIdx = fieldsList.length;
                if (fieldIdx >= defCardFields.length) return;
                const fieldInfo = defCardFields[fieldIdx];
                switch (fieldInfo.type) {
                    case 'SYNTAX':
                        if (keepSyntax) {
                            fieldsList.push(x);
                        } else {
                            // TODO: Maybe translate syntax into proper ruby text?
                            fieldsList.push(
                                x
                                    .replaceAll(/\[.*?\]/g, '')
                                    .replaceAll('{', '')
                                    .replaceAll('}', '')
                            );
                        }
                        break;
                    case 'TEXT':
                        fieldsList.push(x);
                        break;
                    case 'IMAGE':
                        if (shouldIncludeMedia) {
                            const zipPath = await zipMedia(x);
                            if (zipPath) {
                                fieldsList.push(`<img src="${zipPath}>`);
                            } else {
                                fieldsList.push('');
                            }
                        } else {
                            fieldsList.push('');
                        }
                        break;
                    case 'AUDIO':
                    case 'AUDIO_LONG':
                        if (shouldIncludeMedia) {
                            const zipPath = await zipMedia(x);
                            if (zipPath) {
                                fieldsList.push(`[sound:${zipPath}]`);
                            } else {
                                fieldsList.push('');
                            }
                        } else {
                            fieldsList.push('');
                        }
                        break;
                    default:
                        window.alert(
                            'Unable to handle card field definition: ' +
                                fieldInfo.toString()
                        );
                        break;
                }
            };
            await pushField(card.primaryField);
            await pushField(card.secondaryField);
            for (const part of card.fields.split('\u001f')) {
                await pushField(part);
            }
            while (fieldsList.length < defCardFields.length) {
                fieldsList.push('');
            }

            const fieldsStr = fieldsList.join('\x1F');
            const fieldsChecksum = parseInt(
                Array.from(
                    new Uint8Array(
                        await window.crypto.subtle.digest(
                            'SHA-1',
                            new TextEncoder().encode(fieldsStr)
                        )
                    )
                )
                    .map((b) => b.toString(16).padStart(2, '0'))
                    .join('')
                    .substring(0, 8),
                16
            );

            db.run(
                'INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    card.id, // id,
                    crypto.randomUUID(), // guid
                    modelId, // mid
                    card.mod, // mod
                    -1, // usn
                    '', // tags
                    fieldsStr, // flds
                    i, // sfld
                    fieldsChecksum, // csum
                    0, // flags unused
                    '', // data unused
                ]
            );

            const cardTypeNum =
                card.reviewCount == 0 ? 0 : card.interval > 1 ? 2 : 1;
            const cardQueueNum = cardTypeNum;
            let due = cardTypeNum > 0 ? card.due - card.lastReview : i;
            if (cardTypeNum == 1) {
                // learning
                let date = new Date();
                date.setDate(date.getDate() + due);
                due = Math.floor(date.getTime() / 1000);
            }

            if (due < 0) {
                window.alert('Negative due date detected');
                debugger;
            }

            db.run(
                'INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [
                    card.id, // id
                    card.id, // nid
                    1, // did
                    0, // ord
                    card.mod, // mod
                    -1, // usn,
                    cardTypeNum, // type
                    cardQueueNum, // queue
                    due, // due
                    Math.floor(card.interval), // ivl
                    Math.floor(card.factor * 1000), // factor
                    card.reviewCount, // reps
                    card.failCount, // lapses
                    0, // left TODO
                    0, // odue
                    0, // odid
                    0, // flags
                    '', // data unused
                ]
            );
            i += 1;
        }
    }
    db.run('COMMIT');

    zipHandle.file(
        'media',
        JSON.stringify(
            Object.fromEntries(
                new Map(Array.from(invertedMediaMap, (x) => x.reverse()))
            )
        )
    );
};

const ankiDbFillRevlog = (db, reviewHistory, cards) => {
    const revIntervals = new Map();
    reviewHistory.sort((a, b) => a.id - b.id);

    db.run('BEGIN TRANSACTION;');
    for (const review of reviewHistory) {
        let ease = 0;
        // 0 == learn?
        // 1 == fail?
        // 2 == pass?
        if (review.type === 0) {
            ease = 2; // ok (learn) TODO
        } else if (review.type === 1) {
            ease = 1; // wrong (review) TODO
        } else if (review.type == 2) {
            ease = 3; // ok (review) // TODO
        } else {
            window.alert('Unknown review type: ' + review);
            debugger;
        }

        let prevInterval = 0;
        if (revIntervals.has(review.cardId)) {
            prevInterval = revIntervals.get(review.cardId);
        }

        db.run('INSERT INTO revlog VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
            review.id, // id
            review.cardId, // cid
            -1, // usn
            ease, // ease
            Math.floor(review.interval), // ivl
            prevInterval, // lastIvl
            Math.floor(review.factor * 1000), // factor
            Math.min(review.duration, 60) * 1000, // time
            review.type === 0 ? 0 : 1, // type 0=learn 1=review
        ]);
        revIntervals.set(review.cardId, Math.floor(review.interval));
    }
    db.run('COMMIT');
};

const doExportDeck = async (
    SQL,
    db,
    deckId,
    deckName,
    shouldIncludeMedia,
    keepSyntax
) => {
    const cards = fetchDeckCards(db, deckId).filter((x) => !x.del);
    const cardTypes = fetchCardTypes(db);

    const cardsByCardType = new Map();
    for (const card of cards) {
        if (!cardsByCardType.has(card.cardTypeId)) {
            cardsByCardType.set(card.cardTypeId, []);
        }
        cardsByCardType.get(card.cardTypeId).push(card);
    }

    const usedCardTypes = Array.from(cardsByCardType.keys()).map((x) =>
        cardTypes.get(x)
    );

    const mediacacheDb = await openMediaChacheIdb();
    if (shouldIncludeMedia) {
        await mediaCacheGatherAllMedia(
            mediacacheDb,
            cardsByCardType,
            cardTypes
        );
    }

    let zip = new JSZip();
    const ankiDb = initNewAnkiSqlDb(SQL);

    const reviewHistory = fetchReviewHistory(db).filter((x) => !x.del);
    ankiDbFillRevlog(ankiDb, reviewHistory, cards);
    const cardTypeIdsToModelIds = ankiDbPutCol(ankiDb, usedCardTypes);
    await ankiDbFillCards(
        ankiDb,
        mediacacheDb,
        zip,
        cardsByCardType,
        cardTypes,
        cardTypeIdsToModelIds,
        shouldIncludeMedia,
        keepSyntax
    );

    const exportedDb = ankiDb.export();
    zip.file('collection.anki2', exportedDb);
    setStatus(`Constructing apkg file (be patient)`);
    zip.generateAsync({ type: 'blob' }).then((zipBlob) => {
        setStatus('Done');

        const url = URL.createObjectURL(zipBlob);

        const dlElem = document.createElement('a');
        dlElem.href = url;
        dlElem.download = `Migaku - ${deckName}.apkg`;
        dlElem.style = 'display: none;';
        document.body.appendChild(dlElem);

        dlElem.click();
    });
};

const doExportWordlist = async (db, lang) => {
    const wordList = fetchWordListForLang(db, lang);
    const filename = `migaku_words_${lang}.csv`;

    const words = new Array();
    for (const word of wordList) {
        if (word.del) continue;
        const normalizedStatus = word.tracked ? 'TRACKED' : word.knownStatus;
        words.push({
            dictForm: word.dictForm ?? '',
            secondary: word.secondary ?? '',
            hasCard: Boolean(word.hasCard),
            mod: word.mod ?? '',
            language: word.language ?? '',
            knownStatus: normalizedStatus ?? '',
        });
    }

    const escape = (value) => {
        const normalized =
            value === undefined || value === null ? '' : String(value);
        return '"' + normalized.replaceAll('"', '""') + '"';
    };

    const wordsToCsv = (arr) => {
        const header = 'dictForm,secondary,hasCard,mod,language,knownStatus';
        const rows = new Array();
        for (const word of arr) {
            rows.push(
                `${escape(word.dictForm)},${escape(word.secondary)},${
                    word.hasCard
                },${escape(word.mod)},${escape(word.language)},${escape(
                    word.knownStatus
                )}`
            );
        }
        return header + '\n' + rows.join('\n');
    };

    const csvContent = wordsToCsv(words);
    const blob = new Blob([csvContent], {
        type: 'text/csv;charset=utf-8;',
    });
    const url = URL.createObjectURL(blob);

    const dlElem = document.createElement('a');
    dlElem.href = url;
    dlElem.download = filename;
    dlElem.style = 'display: none;';
    document.body.appendChild(dlElem);

    dlElem.click();
    URL.revokeObjectURL(url);
};

const findExportInjectionTarget = () => {
    return (
        document.querySelector('.HomeDecks') ||
        document.querySelector('.HomeDecksEmpty') ||
        document.querySelector('.HomeDecks__empty') ||
        document.querySelector('.Home__Content') ||
        document.querySelector('.Home')
    );
};

function waitForMigaku(cb) {
    const tryInject = () => {
        const target = findExportInjectionTarget();
        if (!target) return false;
        cb(target);
        return true;
    };

    if (tryInject()) return;

    const observer = new MutationObserver((_, observer) => {
        if (tryInject()) observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
}

let srsDb = null;

const inject = async (injectionTarget) => {
    const SQL = await initSqlJs({
        locateFile: () => GM_getResourceURL('sql_wasm'),
    });

    srsDb = await openSrsDb(SQL);
    const initialLang = queryMigakuSelectedLanguage();

    const div = injectionTarget.appendChild(document.createElement('div'));

    const deckSelect = div.appendChild(document.createElement('select'));
    for (const deck of fetchDeckList(srsDb)) {
        if (deck.lang !== initialLang) continue;
        if (deck.del) continue;
        const option = deckSelect.appendChild(document.createElement('option'));
        option.innerText = deck.name;
        option.value = deck.id;
    }

    const exportButton = div.appendChild(document.createElement('button'));
    exportButton.innerText = 'Export deck';

    div.appendChild(document.createElement('br'));
    const includeMediaCheckbox = div.appendChild(
        document.createElement('input')
    );
    includeMediaCheckbox.type = 'checkbox';
    includeMediaCheckbox.id = 'mgkexporterCheckbox';
    const includeMediaLabel = div.appendChild(document.createElement('label'));
    includeMediaLabel.for = includeMediaCheckbox.id;
    includeMediaLabel.innerText =
        'Include media (this may take a very long time and could fail)';

    div.appendChild(document.createElement('br'));
    const keepSyntaxCheckbox = div.appendChild(document.createElement('input'));
    keepSyntaxCheckbox.type = 'checkbox';
    keepSyntaxCheckbox.id = 'mgkexporterKeepsyntaxCheckbox';
    const keepSyntaxLabel = div.appendChild(document.createElement('label'));
    keepSyntaxLabel.for = includeMediaCheckbox.id;
    keepSyntaxLabel.innerText =
        'Keep migaku syntax (your note type can display furigana with it)';

    exportButton.onclick = async () => {
        const deckId = deckSelect.options[deckSelect.selectedIndex].value;
        const deckName = deckSelect.options[deckSelect.selectedIndex].innerText;
        await doExportDeck(
            SQL,
            srsDb,
            deckId,
            deckName,
            includeMediaCheckbox.checked,
            keepSyntaxCheckbox.checked
        );
    };

    const statusMessageElem = div.appendChild(document.createElement('div'));
    statusMessageElem.id = statusMessageElemId;

    const exportWordlistButton = div.appendChild(
        document.createElement('button')
    );
    exportWordlistButton.innerText = 'Export words';
    exportWordlistButton.onclick = async () => {
        await doExportWordlist(srsDb, queryMigakuSelectedLanguage());
    };
};

waitForMigaku((target) => {
    inject(target);
});
