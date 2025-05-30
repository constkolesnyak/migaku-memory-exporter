// ==UserScript==
// @name        Migaku deck exporter
// @namespace   Violentmonkey Scripts
// @match       https://study.migaku.com/*
// @grant       GM_getResourceURL
// @version     1.0
// @author      -
// @description 29/05/2025, 13:09:19
// @require      data:application/javascript,%3BglobalThis.setImmediate%3DsetTimeout%3B
// @require https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/sql-wasm.js
// @resource sql_wasm https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/sql-wasm.wasm
// @require https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js
// ==/UserScript==


const statusMessageElemId = "mgkexporterStatusMessage";


const decompress = async (blob) => {
    const ds = new DecompressionStream("gzip");
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
        console.log("Fetching firebase database")
        const dbRequest = indexedDB.open('firebaseLocalStorageDb', 1);
        dbRequest.onsuccess = function (event) {
            const idb = dbRequest.result;
            const transaction = idb.transaction('firebaseLocalStorage', 'readonly');
            const objectStore = transaction.objectStore('firebaseLocalStorage');
            objectStore.getAll().onsuccess = (event) => {
                resolve(event.target.result);
            };
            idb.close();
        };
    });
};

const fetchGoogleAuth = async (firebaseApiKey, refreshToken) => {
    const url = `https://securetoken.googleapis.com/v1/token?key=${firebaseApiKey}`
    const resp = await fetch(url, {method: "post", body: new URLSearchParams({
        "grant_type": "refresh_token",
        "refresh_token": refreshToken,
    })});
    return await resp.json();
};

const fetchAccessToken = async () => {
    const firebaseInfo = (await fetchFirebaseLocalStorageDbRows())[0].value;
    const auth = await fetchGoogleAuth(firebaseInfo.apiKey, firebaseInfo.stsTokenManager.refreshToken);
    let exp = Date.now() + ((Number(auth.expires_in) - 5) * 1000);
    return {token: auth.access_token, expiresAt: exp};
};


const fetchRawSrsDb = () => {
    return new Promise((resolve) => {
        console.log("Fetching raw database")
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

                    const blob = new Blob([data], { type: "application/octet-stream" });
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
        console.log("Refreshing auth token")
        const newAuth = await fetchAccessToken();
        auth.token = newAuth.token;
        auth.expiresAt = newAuth.expiresAt;
    }
    const baseUrl = "https://file-sync-worker-api.migaku.com/data/"
    const url = baseUrl + path;
    const resp = await fetch(url, {
        headers: {
            "Authorization": "Bearer " + auth.token,
        },
        cache: "force-cache",
    });
    return await resp.blob();
};

const queryMigakuSelectedLanguage = () => {
    return document.querySelector("main.MIGAKU-SRS").getAttribute("data-mgk-lang-selected");
}


const openSrsDb = (SQL) => {
    return new Promise((resolve) => {
        fetchRawSrsDb().then((raw) => {
            resolve(new SQL.Database(raw));
        });
    });
}


const convDbRowToObject = (columnNames, rowVals) => {
    const row = {};
    let i = 0;
    for (const colName of columnNames) {
        if (colName == "del") {
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
    return convDbRowsToObjectArray(
        db.exec(query, args)[0]
    );
}


const fetchDeckList = (db) => {
    return fetchDbRowsAsObjectArray(db, "SELECT id, lang, name, del FROM deck;");
};

const fetchDeckCards = (db, deckId) => {
    return fetchDbRowsAsObjectArray(db, "SELECT id, mod, del, cardTypeId, created, primaryField, secondaryField, fields, words, due, interval, factor, lastReview, reviewCount, passCount, failCount, suspended FROM card WHERE deckId=?", [deckId]);
};

const fetchCardTypes = (db) => {
    let rows = fetchDbRowsAsObjectArray(db, "SELECT id, del, lang, name, config FROM card_type");
    const res = new Map();
    for (const row of rows) {
        row.config = JSON.parse(row.config);
        res.set(row.id, row);
    }
    return res;
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
        );
        CREATE TABLE col (
            id integer primary key,
            crt integer not null,
            mod integer not null,
            scm integer not null,
            ver integer not null,
            dty integer not null,
            usn integer not null,
            ls integr not null,
            conf text not null,
            models text not null,
            decks text not null,
            dconf text not null,
            tags text not null
        );
        CREATE TABLE graves (
            usn integer not null,
            oid integer not null,
            type integer not null
        );
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
        );
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
        );
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
            window.alert("Bad card type entry");
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
                font: "Arial",
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
            case "Sentence":
                cardType.config.fields.forEach((x) => pushField(x.name));
                template = {
                    name: "Basic",
                    qfmt: "{{Word}}<br>{{Sentence}}",
                    did: null,
                    bafmt: "",
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
                    bqfmt: "",
                };
                break;
            case "Word":
            case "Audio Sentence":
            case "Audio Word":
            default:
                debugger;
                window.alert("Unimplemented card type: " + cardType.toString());
                throw Error();
        }

        if (!template) {
            window.alert("Internal error: Did not produce a card template for " + cardType.toString())
            throw Error("Bad template")
        }

        models[cardTypeIdsToModelIds.get(cardType.id)] = {
            css: "",
            did: 1,
            flds: fields,
            id: cardTypeIdsToModelIds.get(cardType.id),
            latexPost: "",
            latexPre: "",
            mod: Math.floor(Date.now() / 1000),
            name: "base",
            req: [], // unused
            sortf: 0,
            tags: [],
            tmpls: [template],
            type: 0, // standard
            usn: -1,
            vers: []
        };
    }

    const decks = {
        1: {
            name: "Default",
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
            desc: "",
        }
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
            name: "Default",
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
        }
    };

    db.run(
        "INSERT INTO col VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
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
            "{}", // tags
        ]
    )
    return cardTypeIdsToModelIds;
};

const ankiDbFillCards = async (db, zipHandle, cardsByCardType, cardTypes, cardTypeIdsToModelIds, shouldIncludeMedia) => {
    const invertedMediaMap = new Map();
    let curMediaNum = 1;

    let accessToken = shouldIncludeMedia ? await fetchAccessToken() : null;
    const fetchAndZipMedia = async (path, cardIdx, cardTotal) => {
        const zipPath = Array.from(
            new Uint8Array(
                await window.crypto.subtle.digest(
                    "SHA-1",
                    new TextEncoder().encode(path)
                )
            )
        ).map((b) => b.toString(16).padStart(2, "0")).join("") + "." + path.split(".").pop();
        if (!invertedMediaMap.has(zipPath)) {
            document.getElementById(statusMessageElemId).innerText = `${cardIdx}/${cardTotal}\n Downloading ${path}`;
            let blob = await fetchMigakuSrsMedia(path.slice(5), accessToken);
            zipHandle.file(zipPath, blob)
            invertedMediaMap.set(zipPath, curMediaNum.toString());
            curMediaNum++;
        }
        return zipPath;
    };

    db.run("BEGIN TRANSACTION;");
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
                    case "SYNTAX":
                        // TODO: Maybe translate syntax into proper ruby text?
                        fieldsList.push(x.replaceAll(/\[.*?\]/g, "").replaceAll("{", "").replaceAll("}", ""));
                        break;
                    case "TEXT":
                        fieldsList.push(x);
                        break;
                    case "IMAGE":
                        if (shouldIncludeMedia) {
                            let zipPath = await fetchAndZipMedia(x, i, cardList.length);
                            fieldsList.push(`<img src="${zipPath}>`);
                        } else {
                            fieldsList.push("");
                        }
                        break;
                    case "AUDIO":
                    case "AUDIO_LONG":
                        if (shouldIncludeMedia) {
                            let zipPath = await fetchAndZipMedia(x, i, cardList.length);
                            fieldsList.push(`[sound:${zipPath}]`);
                        } else {
                            fieldsList.push("");
                        }
                        break;
                    default:
                        window.alert("Unable to handle card field definition: " + fieldInfo.toString());
                        break;
                }
            }
            await pushField(card.primaryField);
            await pushField(card.secondaryField);
            for (const part of card.fields.split("\u001f")) {
                await pushField(part);
            }
            while (fieldsList.length < defCardFields.length) {
                fieldsList.push("");
            }

            const fieldsStr = fieldsList.join("\x1F");
            const fieldsChecksum = parseInt(
                Array.from(
                    new Uint8Array(
                        await window.crypto.subtle.digest(
                            "SHA-1",
                            new TextEncoder().encode(fieldsStr)
                        )
                    )
                ).map((b) => b.toString(16).padStart(2, "0")).join("").substring(0, 8),
                16
            );

            db.run(
                "INSERT INTO notes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [
                    card.id, // id,
                    crypto.randomUUID(), // guid
                    modelId, // mid
                    card.mod, // mod
                    -1, // usn
                    "", // tags
                    fieldsStr, // flds
                    i, // sfld
                    fieldsChecksum, // csum
                    0, // flags unused
                    "" // data unused
                ]
            )

            const cardTypeNum = card.reviewCount == 0 ? 0 : (card.interval > 1 ? 2 : 1);
            const cardQueueNum = cardTypeNum;
            let due = (cardTypeNum > 0) ? (card.due - card.lastReview) : i;
            if (cardTypeNum == 1) {
                // learning
                let date = new Date();
                date.setDate(date.getDate() + due);
                due = Math.floor(date.getTime() / 1000);
            }

            if (due < 0) {
                window.alert("Negative due date detected")
                debugger;
            }

            db.run(
                "INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
                    "", // data unused
                ]
            )
            i += 1;
        }
    }
    db.run("COMMIT");

    zipHandle.file("media", JSON.stringify(new Map(
        Array.from(invertedMediaMap, x => x.reverse())
    )));
};


const doExportDeck = async (SQL, db, deckId, deckName, shouldIncludeMedia) => {
    const cards = fetchDeckCards(db, deckId).filter((x) => !x.del);
    const cardTypes = fetchCardTypes(db);

    const cardsByCardType = new Map();
    for (const card of cards) {
        if (!cardsByCardType.has(card.cardTypeId)) {
            cardsByCardType.set(card.cardTypeId, []);
        }
        cardsByCardType.get(card.cardTypeId).push(card);
    }

    const usedCardTypes = Array.from(cardsByCardType.keys()).map((x) => cardTypes.get(x));

    let zip = new JSZip();
    const ankiDb = initNewAnkiSqlDb(SQL);
    const cardTypeIdsToModelIds = ankiDbPutCol(ankiDb, usedCardTypes);
    await ankiDbFillCards(ankiDb, zip, cardsByCardType, cardTypes, cardTypeIdsToModelIds, shouldIncludeMedia);

    const exportedDb = ankiDb.export();
    zip.file("collection.anki2", exportedDb);
    zip.generateAsync({type: "blob"}).then((zipBlob) => {
        document.getElementById(statusMessageElemId).innerText = "Done";

        const url = URL.createObjectURL(zipBlob);

        const dlElem = document.createElement("a");
        dlElem.href = url;
        dlElem.download = `Migaku - ${deckName}.apkg`;
        dlElem.style = "display: none;";
        document.body.appendChild(dlElem);

        dlElem.click();
    });
};

function waitForMigaku(cb) {
    const observer = new MutationObserver((_, observer) => {
        if (document.querySelector(".HomeDecks")) {
            observer.disconnect();
            cb();
        }
    });
    observer.observe(document, {childList: true, subtree: true});
};


let srsDb = null;

const inject = async () => {
    const SQL = await initSqlJs({ locateFile: () => GM_getResourceURL("sql_wasm") });

    srsDb = await openSrsDb(SQL);
    const migakuLang = queryMigakuSelectedLanguage();

    const div = document.querySelector(".HomeDecks").appendChild(document.createElement("div"));

    const deckSelect = div.appendChild(document.createElement("select"));
    for (const deck of fetchDeckList(srsDb)) {
        if (deck.lang !== migakuLang) continue;
        if (deck.del) continue;
        const option = deckSelect.appendChild(document.createElement("option"));
        option.innerText = deck.name;
        option.value = deck.id;
    }

    const exportButton = div.appendChild(document.createElement("button"));
    exportButton.innerText = "Export deck";

    div.appendChild(document.createElement("br"));
    const includeMediaCheckbox = div.appendChild(document.createElement("input"))
    includeMediaCheckbox.type = "checkbox"
    includeMediaCheckbox.id = "mgkexporterCheckbox";
    const includeMediaLabel = div.appendChild(document.createElement("label"));
    includeMediaLabel.for = includeMediaCheckbox.id;
    includeMediaLabel.innerText = "Include media (this may take a very long time and could fail)"

    exportButton.onclick = async () => {
        const deckId = deckSelect.options[deckSelect.selectedIndex].value;
        const deckName = deckSelect.options[deckSelect.selectedIndex].innerText;
        await doExportDeck(SQL, srsDb, deckId, deckName, includeMediaCheckbox.checked);
    };

    const statusMessageElem = div.appendChild(document.createElement("div"));
    statusMessageElem.id = statusMessageElemId;
}

waitForMigaku(() => {
    inject();
});
