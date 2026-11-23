import React, { useState, useEffect, useRef, useCallback } from "react";
import PropTypes from "prop-types";
import * as d3 from "d3";

/**
 * AnomalyHeatmap
 *
 * Renders a dynamic heatmap of an anomaly correlation matrix using D3.
 * Features:
 *   - Zoom & pan
 *   - Tooltip on hover
 *   - Threshold filter control
 *   - Data fetched from a JWT‑protected API
 *
 * Expected API response shape:
 * {
 *   "matrix": [[number, ...], ...],   // square matrix of correlation values
 *   "labels": ["label1", "label2", ...] // length equals matrix dimension
 * }
 *
 * Color mapping uses a diverging scale:
 *   color = interpolateRdBu( (value + 1) / 2 )
 *   where value ∈ [-1, 1] (correlation coefficient)
 */
function AnomalyHeatmap({ apiUrl, token, initialThreshold }) {
  const svgRef = useRef(null);
  const tooltipRef = useRef(null);
  const [matrix, setMatrix] = useState([]);
  const [labels, setLabels] = useState([]);
  const [threshold, setThreshold] = useState(initialThreshold);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // -------------------------------------------------------------------------
  // Data fetching
  // -------------------------------------------------------------------------
  const fetchData = useCallback(async () => {
    if (!apiUrl || typeof apiUrl !== "string") {
      setError(new Error("Invalid API URL"));
      setLoading(false);
      return;
    }

    const headers = token
      ? { Authorization: `Bearer ${token}` }
      : {};

    try {
      const response = await fetch(apiUrl, { headers });
      if (!response.ok) {
        throw new Error(`API request failed with status ${response.status}`);
      }
      const json = await response.json();

      // Validate response shape
      if (
        !Array.isArray(json.matrix) ||
        !Array.isArray(json.labels) ||
        json.matrix.length !== json.labels.length ||
        json.matrix.some(row => !Array.isArray(row) || row.length !== json.labels.length)
      ) {
        throw new Error("Invalid data format received from API");
      }

      setMatrix(json.matrix);
      setLabels(json.labels);
      setError(null);
    } catch (err) {
      console.error("Failed to fetch heatmap data:", err);
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [apiUrl, token]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // -------------------------------------------------------------------------
  // D3 Rendering
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (loading || error || matrix.length === 0) return;

    const svg = d3.select(svgRef.current);
    const tooltip = d3.select(tooltipRef.current);
    const width = parseInt(svg.style("width")) || 800;
    const height = parseInt(svg.style("height")) || 800;
    const margin = { top: 100, right: 20, bottom: 20, left: 100 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    // Clear previous content
    svg.selectAll("*").remove();

    // Scales
    const xScale = d3
      .scaleBand()
      .domain(labels)
      .range([0, innerWidth])
      .padding(0.05);

    const yScale = d3
      .scaleBand()
      .domain(labels)
      .range([0, innerHeight])
      .padding(0.05);

    // Diverging color scale for correlation ∈ [-1, 1]
    const colorScale = d3
      .scaleSequential()
      .interpolator(d3.interpolateRdBu)
      .domain([-1, 1]);

    // Container for zoomable content
    const zoomGroup = svg
      .append("g")
      .attr("transform", `translate(${margin.left},${margin.top})`);

    // Draw cells
    const cellsData = [];
    matrix.forEach((row, i) => {
      row.forEach((value, j) => {
        if (Math.abs(value) >= threshold) {
          cellsData.push({
            x: labels[j],
            y: labels[i],
            value,
          });
        }
      });
    });

    zoomGroup
      .selectAll("rect")
      .data(cellsData, d => `${d.x}-${d.y}`)
      .enter()
      .append("rect")
      .attr("x", d => xScale(d.x))
      .attr("y", d => yScale(d.y))
      .attr("width", xScale.bandwidth())
      .attr("height", yScale.bandwidth())
      .attr("fill", d => colorScale(d.value))
      .on("mouseover", (event, d) => {
        tooltip
          .style("opacity", 0.9)
          .html(
            `<strong>${d.y} ↔ ${d.x}</strong><br/>Correlation: ${d.value.toFixed(
              3
            )}`
          )
          .style("left", `${event.pageX + 10}px`)
          .style("top", `${event.pageY - 28}px`);
      })
      .on("mouseout", () => {
        tooltip.style("opacity", 0);
      });

    // Axes
    const xAxis = d3.axisTop(xScale).tickSize(0);
    const yAxis = d3.axisLeft(yScale).tickSize(0);

    zoomGroup
      .append("g")
      .attr("class", "x axis")
      .call(xAxis)
      .selectAll("text")
      .attr("transform", "rotate(-45)")
      .style("text-anchor", "start");

    zoomGroup
      .append("g")
      .attr("class", "y axis")
      .call(yAxis);

    // Zoom behavior
    const zoom = d3
      .zoom()
      .scaleExtent([0.5, 10])
      .on("zoom", (event) => {
        zoomGroup.attr("transform", event.transform);
      });

    svg.call(zoom);

    // Cleanup on unmount or re-render
    return () => {
      svg.selectAll("*").remove();
    };
  }, [matrix, labels, threshold, loading, error]);

  // -------------------------------------------------------------------------
  // UI Handlers
  // -------------------------------------------------------------------------
  const handleThresholdChange = (e) => {
    const val = parseFloat(e.target.value);
    if (!isNaN(val) && val >= 0 && val <= 1) {
      setThreshold(val);
    }
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <div style={{ position: "relative", width: "100%", height: "100%" }}>
      {loading && <div>Loading heatmap...</div>}
      {error && <div style={{ color: "red" }}>{error.message}</div>}
      <div style={{ marginBottom: "10px" }}>
        <label htmlFor="threshold-slider">
          Correlation Threshold: {threshold.toFixed(2)}
        </label>
        <input
          id="threshold-slider"
          type="range"
          min="0"
          max="1"