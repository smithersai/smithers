// @ts-nocheck
import React, { useEffect, useState } from "react";
import { useKeyboard } from "@opentui/react";
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */

/**
 * @param {{ adapter: SmithersDb; onBack: () => void; }} value
 */
export function SqliteBrowser({ adapter, onBack, }) {
    const [tables, setTables] = useState([]);
    const [selectedTableIdx, setSelectedTableIdx] = useState(0);
    const [query, setQuery] = useState("");
    const [results, setResults] = useState([]);
    const [error, setError] = useState(null);
    const [focusedPane, setFocusedPane] = useState("tables");
    // Fetch tables on mount
    useEffect(() => {
        let mounted = true;
        adapter.rawQuery("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
            .then((res) => {
            if (mounted) {
                const names = res.map((r) => r.name).sort();
                setTables(names);
                if (names.length > 0) {
                    setQuery(`SELECT * FROM ${names[0]} LIMIT 50;`);
                }
            }
        })
            .catch((err) => {
            if (mounted)
                setError(err.message);
        });
        return () => { mounted = false; };
    }, [adapter]);
    // Execute query whenever it changes
    useEffect(() => {
        let mounted = true;
        if (!query.trim()) {
            setResults([]);
            return;
        }
        adapter.rawQuery(query)
            .then((res) => {
            if (mounted) {
                setResults(res);
                setError(null);
            }
        })
            .catch((err) => {
            if (mounted) {
                setError(err.message);
                setResults([]);
            }
        });
        return () => { mounted = false; };
    }, [adapter, query]);
    useKeyboard((key) => {
        if (key.name === "escape") {
            if (focusedPane === "query") {
                setFocusedPane("tables");
            }
            else {
                onBack();
            }
            return;
        }
        if (key.name === "tab") {
            setFocusedPane((p) => p === "tables" ? "query" : p === "query" ? "results" : "tables");
            return;
        }
        if (focusedPane === "tables" && tables.length > 0) {
            if (key.name === "down" || key.name === "j") {
                const next = Math.min(tables.length - 1, selectedTableIdx + 1);
                setSelectedTableIdx(next);
                setQuery(`SELECT * FROM ${tables[next]} LIMIT 50;`);
            }
            if (key.name === "up" || key.name === "k") {
                const prev = Math.max(0, selectedTableIdx - 1);
                setSelectedTableIdx(prev);
                setQuery(`SELECT * FROM ${tables[prev]} LIMIT 50;`);
            }
        }
        if (focusedPane === "query") {
            if (key.name === "backspace") {
                setQuery((q) => q.slice(0, -1));
                return;
            }
            if (key.name === "enter" || key.name === "return") {
                setFocusedPane("results");
                return;
            }
            if (!key.ctrl && !key.meta && key.sequence && key.sequence.length === 1 && key.name !== "up" && key.name !== "down" && key.name !== "left" && key.name !== "right") {
                setQuery((q) => q + key.sequence);
            }
        }
    });
    const tableOptions = tables.map((t) => ({
        name: t,
        value: t,
    }));
    const resultText = error
        ? `[!] Query Error:\n${error}`
        : results.length === 0
            ? "No results."
            : JSON.stringify(results, null, 2);
    return (<box style={{ flexGrow: 1, width: "100%", height: "100%", flexDirection: "row" }}>
      {/* Left Pane: Tables List */}
      <box style={{ width: 30, height: "100%", borderRight: true, borderColor: focusedPane === "tables" ? "#34d399" : "gray", flexDirection: "column" }}>
        <text style={{ color: focusedPane === "tables" ? "white" : "gray", marginBottom: 1 }}> Tables </text>
        <select style={{ width: "100%", flexGrow: 1 }} options={tableOptions} focused={focusedPane === "tables"} onChange={(idx) => {
            setSelectedTableIdx(idx);
            setQuery(`SELECT * FROM ${tables[idx]} LIMIT 50;`);
        }} textColor="#E2E8F0" selectedTextColor="#34d399" selectedBackgroundColor="#1f2937"/>
      </box>
      
      {/* Right Pane: Query & Results */}
      <box style={{ flexGrow: 1, height: "100%", flexDirection: "column", paddingLeft: 1 }}>
        <box style={{ width: "100%", height: 3, borderBottom: true, borderColor: focusedPane === "query" ? "#34d399" : "gray", flexDirection: "column" }}>
          <text style={{ color: "yellow" }}> SQL Query: {focusedPane === "query" ? "(Press Enter to run)" : ""} </text>
          {focusedPane === "query" ? (<text style={{ color: "white", marginTop: 1 }}>{"> "}{query}█</text>) : (<text style={{ color: "white", marginTop: 1 }}>{query}</text>)}
        </box>
        
        <box style={{ flexGrow: 1, width: "100%", flexDirection: "column", marginTop: 1 }}>
          <text style={{ color: "gray", marginBottom: 1 }}> Results ({results.length} rows) </text>
          <scrollbox style={{ flexGrow: 1, width: "100%" }}>
            <text style={{ color: error ? "red" : "#a7f3d0" }}>{resultText}</text>
          </scrollbox>
        </box>
      </box>
    </box>);
}
