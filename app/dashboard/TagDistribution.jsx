import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { PieChart, Pie, Cell, Label, ResponsiveContainer } from "recharts";
import { ChartContainer, ChartTooltip } from "@/components/ui/chart";
import { Skeleton } from "@/components/ui/skeleton";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

export function TagDistributionChart({
  title,
  description,
  centerLabel,
  resultLabel,
  data,
  total,
  loading,
  getTagHref,
  totalHref,
  embedded = false,
}) {
  const router = useRouter();
  const distributionTotal = Number.parseInt(total, 10) || 0;
  const [windowWidth, setWindowWidth] = useState(
    typeof window !== "undefined" ? window.innerWidth : 1200
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    const handleResize = () => {
      setWindowWidth(window.innerWidth);
    };

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Calculate responsive chart dimensions
  const getChartDimensions = () => {
    if (windowWidth < 640) {
      // Mobile
      return {
        innerRadius: 60,
        outerRadius: 80,
        labelY: 20, // Smaller offset for the label
        fontSize: "text-2xl", // Smaller font for total
        subtextSize: "text-xs", // Smaller subtext
      };
    } else {
      return {
        innerRadius: 80,
        outerRadius: 110,
        labelY: 30, // Original offset
        fontSize: "text-3xl", // Original font size
        subtextSize: "text-sm", // Original subtext size
      };
    }
  };

  const { innerRadius, outerRadius, labelY, fontSize, subtextSize } =
    getChartDimensions();

  const chartConfig = {
    tag: {
      label: title,
      color: "var(--chart-1)",
    },
  };

  const content = (
    <>
      <CardHeader className={embedded ? "px-0 pb-2" : "pb-2 sm:pb-6"}>
        <CardTitle className="text-xl sm:text-2xl">{title}</CardTitle>
        <CardDescription className="text-xs sm:text-sm">
          {description} in the selected period
        </CardDescription>
      </CardHeader>
      <CardContent className={embedded ? "px-0 pb-0 pt-0" : "flex-1 pt-0 sm:pt-4"}>
        {loading ? (
          <Skeleton className="mx-auto aspect-square h-[200px] sm:h-[300px]" />
        ) : (
          <ChartContainer
            config={chartConfig}
            className="mx-auto aspect-square max-h-[200px] sm:max-h-[300px]"
          >
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <ChartTooltip
                  content={({ active, payload }) => {
                    if (active && payload && payload.length) {
                      const data = payload[0].payload;
                      return (
                        <div className="rounded-md border bg-background p-2 shadow-sm">
                          <div className="grid grid-cols-2 gap-2">
                            <div className="flex flex-col">
                              <span className="text-[0.70rem] uppercase text-muted-foreground">
                                Category
                              </span>
                              <span className="font-bold">{data.category}</span>
                            </div>
                            <div className="flex flex-col">
                              <span className="text-[0.70rem] uppercase text-muted-foreground">
                                Count
                              </span>
                              <span className="font-bold">{data.count}</span>
                            </div>
                          </div>
                        </div>
                      );
                    }
                    return null;
                  }}
                />
                <Pie
                  data={data}
                  dataKey="count"
                  nameKey="category"
                  innerRadius={innerRadius}
                  outerRadius={outerRadius}
                  paddingAngle={2}
                  onClick={(entry) => {
                    const category = entry?.category || entry?.payload?.category;
                    if (category) router.push(getTagHref(category));
                  }}
                >
                  {data.map((entry, index) => (
                    <Cell
                      key={entry.category}
                      fill={entry.color || `var(--chart-${(index % 12) + 1})`}
                      className="cursor-pointer outline-none"
                    />
                  ))}
                  <Label
                    content={({ viewBox }) => (
                      <text
                        x={viewBox.cx}
                        y={viewBox.cy}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        role={totalHref ? "link" : undefined}
                        tabIndex={totalHref ? 0 : undefined}
                        aria-label={
                          totalHref
                            ? `View all tagged ${resultLabel} in Recognition Feed`
                            : undefined
                        }
                        className={totalHref ? "cursor-pointer outline-none" : undefined}
                        onClick={() => totalHref && router.push(totalHref)}
                        onKeyDown={(event) => {
                          if (
                            totalHref &&
                            (event.key === "Enter" || event.key === " ")
                          ) {
                            event.preventDefault();
                            router.push(totalHref);
                          }
                        }}
                      >
                        <tspan
                          x={viewBox.cx}
                          y={viewBox.cy}
                          className={`fill-foreground font-bold ${fontSize}`}
                        >
                          {distributionTotal}
                        </tspan>
                        <tspan
                          x={viewBox.cx}
                          y={viewBox.cy + labelY}
                          className={`fill-muted-foreground ${subtextSize}`}
                        >
                          {centerLabel}
                        </tspan>
                      </text>
                    )}
                  />
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </ChartContainer>
        )}
        <div className="mt-2 sm:mt-4 space-y-1 text-[10px] sm:text-sm">
          {data.map((item) => (
            <Link
              key={item.category}
              href={getTagHref(item.category)}
              className="flex items-center justify-between rounded-sm hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`View ${item.category} ${resultLabel} in Recognition Feed`}
            >
              <div className="flex items-center gap-1 sm:gap-2">
                <div
                  className="h-2 w-2 sm:h-3 sm:w-3 rounded-full"
                  style={{ backgroundColor: item.color }}
                />
                <span>{item.category}</span>
              </div>
              <span className="font-medium">{item.percentage}%</span>
            </Link>
          ))}
        </div>
      </CardContent>
    </>
  );

  if (embedded) {
    return <section className="min-w-0">{content}</section>;
  }

  return (
    <Card className="dark:bg-[#0e0e10] h-full rounded-lg">
      {content}
    </Card>
  );
}

export function TagDistributionComparison({
  loading,
  vehicleData,
  vehicleTotal,
  getVehicleHref,
  vehicleTotalHref,
  readData,
  readTotal,
  getReadHref,
  readTotalHref,
}) {
  return (
    <Card className="dark:bg-[#0e0e10] h-full rounded-lg">
      <CardHeader className="pb-2 sm:pb-4">
        <CardTitle className="text-xl sm:text-2xl">Tag Distribution</CardTitle>
        <CardDescription className="text-xs sm:text-sm">
          Compare distinct tagged vehicles with every tagged plate read
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-6 pt-0 md:grid-cols-2 md:gap-0">
        <div className="min-w-0 md:pr-5">
          <TagDistributionChart
            embedded
            title="Tagged Vehicles"
            description="Distinct corrected plate identities by tag"
            centerLabel="Vehicles"
            resultLabel="vehicles"
            data={vehicleData}
            total={vehicleTotal}
            loading={loading}
            getTagHref={getVehicleHref}
            totalHref={vehicleTotalHref}
          />
        </div>
        <div className="min-w-0 border-t pt-6 md:border-l md:border-t-0 md:pl-5 md:pt-0">
          <TagDistributionChart
            embedded
            title="Tagged Plate Reads"
            description="Every matching plate capture by tag"
            centerLabel="Reads"
            resultLabel="plate reads"
            data={readData}
            total={readTotal}
            loading={loading}
            getTagHref={getReadHref}
            totalHref={readTotalHref}
          />
        </div>
      </CardContent>
    </Card>
  );
}
