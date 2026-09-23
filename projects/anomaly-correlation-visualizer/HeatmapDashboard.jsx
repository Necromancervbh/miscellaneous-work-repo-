import React, { useEffect, useRef, useState } from "react";
import * as d3 from "d3";
import PropTypes from "prop-types";

/**
 * HeatmapDashboard
 *
 * Subscribes to an orchestrator WebSocket, aggregates anomaly scores per sensor
 * and time bucket, and renders an interactive D3 heatmap with zoom/pan.
 *
 * Props:
 *   wsUrl        - string, WebSocket URL (required)
 *   width        - number, SVG width in pixels (default: 800)
 *   height       - number, SVG height in pixels (default: 600)
 *   bucketSizeMs - number, size of time bucket in milliseconds (default: 1000)
 *   windowMs     - number, length of sliding window in milliseconds (default: 5 * 60 * 1000)
 */
export default function HeatmapDashboard({
  wsUrl,
  width = 800,
  height = 600,
  bucketSizeMs = 1000,
  windowMs = 5 * 60 * 1000,
}) {
  // Validate props
  if (typeof wsUrl !== "string" || wsUrl.trim() === "") {
    throw new Error("HeatmapDashboard: wsUrl must be a non‑empty string");
  }
  if (width <= 0 || height <= 0) {
    throw new Error("HeatmapDashboard: width and height must be positive numbers");
  }
  if (bucketSizeMs <= 0) {
    throw new Error("HeatmapDashboard: bucketSizeMs must be a positive number");
  }
  if (windowMs <= 0) {
    throw new Error("HeatmapDashboard: windowMs must be a positive number");
  }

  const svgRef = useRef(null);
  const wsRef = useRef(null);
  const [dataVersion, setDataVersion] = useState(0); // trigger re‑render on data change

  // Internal data structures
  // sensorId -> Map(bucketIndex -> { sum: number, count: number })
  const sensorsDataRef = useRef(new Map());

  // Keep track of known sensor IDs for ordering
  const sensorIdsRef = useRef([]);

  // Helper: compute bucket index from timestamp
  const getBucketIndex = (timestamp) => Math.floor(timestamp / bucketSizeMs);

  // WebSocket handling
  useEffect(() => {
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      console.error("HeatmapDashboard: Failed to create WebSocket", err);
      return;
    }
    wsRef.current = ws;

    ws.onopen = () => {
      console.info("HeatmapDashboard: WebSocket connection opened");
    };

    ws.onerror = (event) => {
      console.error("HeatmapDashboard: WebSocket error", event);
    };

    ws.onclose = (event) => {
      console.info(
        `HeatmapDashboard: WebSocket closed (code=${event.code}, reason=${event.reason})`
      );
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        // Expected shape: { timestamp: number (ms), sensorId: string, score: number (0‑1) }
        if (
          typeof msg.timestamp !== "number" ||
          typeof msg.sensorId !== "string" ||
          typeof msg.score !== "number"
        ) {
          console.warn("HeatmapDashboard: Invalid message format", msg);
          return;
        }

        const bucketIdx = getBucketIndex(msg.timestamp);
        let sensorMap = sensorsDataRef.current.get(msg.sensorId);
        if (!sensorMap) {
          sensorMap = new Map();
          sensorsDataRef.current.set(msg.sensorId, sensorMap);
          sensorIdsRef.current.push(msg.sensorId);
        }

        const bucket = sensorMap.get(bucketIdx) || { sum: 0, count: 0 };
        bucket.sum += msg.score;
        bucket.count += 1;
        sensorMap.set(bucketIdx, bucket);
      } catch (e) {
        console.error("HeatmapDashboard: Failed to process WebSocket message", e);
      }
    };

    // Cleanup on unmount
    return () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, [wsUrl]);

  // Periodic pruning and UI update (every second)
  useEffect(() => {
    const intervalId = setInterval(() => {
      const now = Date.now();
      const minBucketIdx = getBucketIndex(now - windowMs);

      // Prune old buckets for each sensor
      sensorsDataRef.current.forEach((bucketMap) => {
        for (const key of bucketMap.keys()) {
          if (key < minBucketIdx) {
            bucketMap.delete(key);
          }
        }
      });

      // Trigger D3 redraw
      setDataVersion((v) => v + 1);
    }, 1000);

    return () => clearInterval(intervalId);
  }, [windowMs, bucketSizeMs]);

  // D3 rendering
  useEffect(() => {
    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove(); // clear previous content

    // Define margins
    const margin = { top: 20, right: 20, bottom: 30, left: 80 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    // Create root group
    const g = svg
      .attr("width", width)
      .attr("height", height)
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    // Prepare data matrix
    const now = Date.now();
    const bucketCount = Math.ceil(windowMs / bucketSizeMs);
    const startBucketIdx = getBucketIndex(now - windowMs) + 1; // exclusive lower bound

    const sensorIds = sensorIdsRef.current.slice().sort(); // deterministic order
    const yScale = d3
      .scaleBand()
      .domain(sensorIds)
      .range([0, innerHeight])
      .paddingInner(0.05);

    const xScale = d3
      .scaleBand()
      .domain(d3.range(bucketCount).map((i) => i.toString()))
      .range([0, innerWidth])
      .paddingInner(0.05);

    // Color scale: interpolate from blue (low) to red (high)
    const colorScale = d3
      .scaleSequential(d3.interpolateRdYlBu)
      .domain([1, 0]); // invert to have high scores red

    // Build flat array of cells
    const cells = [];
    sensorIds.forEach((sensorId) => {
      const bucketMap = sensorsDataRef.current.get(sensorId) || new Map();
      for (let i = 0; i < bucketCount; i++) {
        const bucketIdx = startBucketIdx + i;
        const bucket = bucketMap.get(bucketIdx);
        const avgScore = bucket ? bucket.sum / bucket.count : null;
        cells.push({
          sensorId,
          bucketIdx,
          x: i,
          y: sensorId,
          value