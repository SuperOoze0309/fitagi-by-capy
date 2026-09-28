import { useMemo, useState } from 'react';
import { useI18n } from '../state/AppContext';

/**
 * Dependency-free line chart.
 *
 * The exercise page needs to answer "am I progressing?" at a glance, which a bare
 * sparkline cannot do: there are no axes, so the reader cannot tell a 5 kg gain
 * from a 50 kg one. This draws labelled axes, a light grid, a filled area, and
 * reports the value under the pointer (or the latest point when untouched).
 *
 * Rendered as inline SVG over a fixed viewBox, so it scales to any phone width
 * without a charting library and without layout measurement.
 */
export interface ChartPoint {
  /** X position on the underlying scale, used for spacing only. */
  x: number;
  value: number;
  /** Label shown when this point is active, e.g. "Mar 3". */
  label: string;
  /** Optional secondary line, shown in the active readout. */
  secondary?: string;
}

interface ProgressChartProps {
  points: ChartPoint[];
  unit: string;
  /** Accessible description of what the chart shows. */
  ariaLabel: string;
  height?: number;
}

const WIDTH = 320;
const PADDING = { top: 12, right: 12, bottom: 22, left: 38 };

export function ProgressChart({ points, unit, ariaLabel, height = 132 }: ProgressChartProps) {
  const { t, tPlural } = useI18n();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const geometry = useMemo(() => {
    if (points.length === 0) return null;

    const values = points.map((point) => point.value);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);
    // Pad the range so a flat line does not sit exactly on an axis, and so the
    // top point is not clipped by the plot border.
    const span = rawMax - rawMin;
    const padding = span === 0 ? Math.max(1, rawMax * 0.05) : span * 0.15;
    const min = rawMin - padding;
    const max = rawMax + padding;

    const plotWidth = WIDTH - PADDING.left - PADDING.right;
    const plotHeight = height - PADDING.top - PADDING.bottom;
    const step = points.length > 1 ? plotWidth / (points.length - 1) : 0;

    const coordinates = points.map((point, index) => ({
      point,
      cx: PADDING.left + (points.length > 1 ? index * step : plotWidth / 2),
      cy: PADDING.top + plotHeight - ((point.value - min) / (max - min || 1)) * plotHeight,
    }));

    // Three gridlines is enough to read a value without clutter.
    const ticks = [min, (min + max) / 2, max].map((value) => ({
      value,
      y: PADDING.top + plotHeight - ((value - min) / (max - min || 1)) * plotHeight,
    }));

    return { coordinates, ticks, min, max, plotHeight, plotWidth };
  }, [points, height]);

  if (!geometry) {
    return (
      <p className="small faint" style={{ margin: 'var(--space-3) 0 0' }}>
        {t('exercise.notEnoughSessions')}
      </p>
    );
  }

  const active = activeIndex === null ? null : geometry.coordinates[activeIndex];
  const last = geometry.coordinates[geometry.coordinates.length - 1]!;
  const shown = active ?? last;
  const line = geometry.coordinates.map((entry) => `${entry.cx.toFixed(1)},${entry.cy.toFixed(1)}`).join(' ');
  const area = [
    `${geometry.coordinates[0]!.cx.toFixed(1)},${(PADDING.top + geometry.plotHeight).toFixed(1)}`,
    line,
    `${last.cx.toFixed(1)},${(PADDING.top + geometry.plotHeight).toFixed(1)}`,
  ].join(' ');

  const format = (value: number) => String(Number(value.toFixed(1)));

  return (
    <div style={{ marginTop: 10 }}>
      <div className="row-between small">
        <span style={{ fontWeight: 600 }}>{format(shown.point.value)} {unit}</span>
        <span className="faint">
          {shown.point.label}
          {shown.point.secondary ? ` · ${shown.point.secondary}` : ''}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${WIDTH} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={ariaLabel}
        preserveAspectRatio="none"
        style={{ display: 'block', touchAction: 'pan-y' }}
        onMouseLeave={() => setActiveIndex(null)}
      >
        {geometry.ticks.map((tick) => (
          <g key={tick.value}>
            <line
              x1={PADDING.left}
              x2={WIDTH - PADDING.right}
              y1={tick.y}
              y2={tick.y}
              stroke="var(--border)"
              strokeWidth="1"
            />
            <text
              x={PADDING.left - 5}
              y={tick.y + 3}
              textAnchor="end"
              fontSize="9"
              fill="var(--text-faint)"
            >
              {format(tick.value)}
            </text>
          </g>
        ))}

        <polygon points={area} fill="var(--accent-soft)" />
        <polyline
          points={line}
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2"
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {geometry.coordinates.map((entry, index) => (
          <g key={index}>
            {/* Invisible hit areas so a tap anywhere on the column selects it. */}
            <rect
              x={entry.cx - 12}
              y={PADDING.top}
              width={24}
              height={geometry.plotHeight}
              fill="transparent"
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setActiveIndex(index)}
              onTouchStart={() => setActiveIndex(index)}
            />
            <circle
              cx={entry.cx}
              cy={entry.cy}
              r={index === (activeIndex ?? geometry.coordinates.length - 1) ? 3.5 : 2}
              fill="var(--accent)"
            />
          </g>
        ))}
      </svg>

      <div className="row-between small faint">
        <span>{points[0]!.label}</span>
        <span>{tPlural('exercise.sessionCount', 'exercise.oneSessionCount', points.length)}</span>
        <span>{points[points.length - 1]!.label}</span>
      </div>
    </div>
  );
}
