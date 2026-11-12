import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Legend, Line, LineChart, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { ChartBody } from "@pandocs/markdown";
import { BlockError, type BlockProps } from "./block-parts";
import { t } from "../i18n";

const SERIES = ["var(--rp-c-brand)", "rgb(7, 156, 112)", "rgb(137, 87, 229)", "rgb(255, 197, 23)", "rgb(237, 60, 80)"];

export default function Chart({ attrs, body, source = "" }: BlockProps) {
  const chart = body as ChartBody | undefined;
  if (!chart) return <BlockError title={t("This chart cannot be read")} source={source} />;
  const first = chart.data[0] ?? {};
  const keys = chart.yKeys ?? Object.keys(first).filter(key => key !== chart.xKey && typeof first[key] === "number");
  const data = chart.data as Record<string, string | number>[];
  const color = (index: number) => SERIES[index % SERIES.length]!;
  const axes = <>
    <CartesianGrid vertical={false} stroke="var(--rp-c-divider-light)" />
    <XAxis dataKey={chart.xKey} tickLine={false} axisLine={false} />
    <YAxis tickLine={false} axisLine={false} width={40} />
    <Tooltip />
    {keys.length > 1 ? <Legend /> : null}
  </>;
  const content = (() => {
    switch (chart.type) {
      case "pie":
        return <PieChart><Tooltip /><Legend /><Pie data={data} dataKey={keys[0] ?? ""} nameKey={chart.xKey} label>{data.map((_, index) => <Cell key={index} fill={color(index)} />)}</Pie></PieChart>;
      case "line":
        return <LineChart data={data}>{axes}{keys.map((key, index) => <Line key={key} dataKey={key} stroke={color(index)} dot={false} />)}</LineChart>;
      case "area":
        return <AreaChart data={data}>{axes}{keys.map((key, index) => <Area key={key} dataKey={key} stroke={color(index)} fill={color(index)} fillOpacity={0.2} />)}</AreaChart>;
      default:
        return <BarChart data={data}>{axes}{keys.map((key, index) => <Bar key={key} dataKey={key} fill={color(index)} radius={4} />)}</BarChart>;
    }
  })();
  return (
    <figure className="pd-chart" data-pandocs-nontext="">
      {attrs.title ? <figcaption>{attrs.title}</figcaption> : null}
      <ResponsiveContainer width="100%" height={260}>{content}</ResponsiveContainer>
    </figure>
  );
}
