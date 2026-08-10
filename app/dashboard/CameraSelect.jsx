import MultiSelectFilter from "@/components/MultiSelectFilter";

export function CameraSelector({ value, onValueChange, cameras, loading }) {
  const selectedCameras = Array.isArray(value) ? value : [];
  const options = (cameras || []).map((camera) => ({
    value: camera,
    label: camera,
  }));

  return (
    <div>
      <fieldset disabled={loading} className="m-0 min-w-0 border-0 p-0">
        <MultiSelectFilter
          ariaLabel="Filter dashboard by cameras"
          allLabel={loading ? "Loading cameras…" : "All cameras"}
          value={selectedCameras}
          options={options}
          onChange={onValueChange}
          className="w-44 dark:bg-[#161618]"
        />
      </fieldset>
    </div>
  );
}
