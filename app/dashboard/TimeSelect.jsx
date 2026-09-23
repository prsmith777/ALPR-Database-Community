import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function TimeFrameSelector({ value, onValueChange }) {
  const timeFrames = [
    { value: "24h", label: "Last 24 Hours" },
    { value: "3d", label: "Last 3 Days" },
    { value: "7d", label: "Last 7 Days" },
    { value: "30d", label: "Last 30 Days" },
    { value: "all", label: "All Time" },
  ];

  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger className="w-[180px] dark:bg-[#161618]">
        <SelectValue placeholder="Select time frame" />
      </SelectTrigger>
      <SelectContent>
        {timeFrames.map((frame) => (
          <SelectItem key={frame.value} value={frame.value}>
            {frame.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
