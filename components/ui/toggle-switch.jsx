import { useState, useEffect } from "react";

const ToggleSwitch = ({
  options = [
    { value: 12, label: "12h" },
    { value: 24, label: "24h" },
  ],
  name,
  defaultValue,
  onChange,
}) => {
  const [selected, setSelected] = useState(defaultValue || options[0].value);

  const handleSelect = (newValue) => {
    setSelected(newValue);
    onChange?.(newValue);
  };

  return (
    <div className="relative p-1 rounded-lg border">
      <input type="hidden" name={name} value={selected} />
      {/* Sliding highlight */}
      <div
        className={`absolute top-1 transition-all duration-200 ease-in-out h-8 w-12 dark:bg-white bg-neutral-900  rounded-md shadow-sm ${
          selected === options[1].value ? "translate-x-12" : "translate-x-0"
        }`}
      />

      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => handleSelect(option.value)}
          className={`relative z-10 w-12 h-8 text-sm font-medium transition-colors duration-200 ${
            selected === option.value
              ? "text-white dark:text-gray-900"
              : "text-gray-500 hover:text-gray-900"
          }`}
          role="radio"
          aria-checked={selected === option.value}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
};

export default ToggleSwitch;
