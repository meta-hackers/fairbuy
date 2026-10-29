import type { CategorySpec } from "../contract";

export const laptopSpec: CategorySpec = {
  id: "laptop",
  label: "Laptop",
  attributes: [
    { key: "ramGb", label: "RAM", type: "number", unit: "GB", better: "higher" },
    { key: "storageGb", label: "Storage", type: "number", unit: "GB", better: "higher" },
    { key: "cpu", label: "CPU", type: "text" },
    { key: "chargerIncluded", label: "Charger included", type: "bool" },
    { key: "warrantyMonths", label: "Warranty", type: "number", unit: "months", better: "higher" },
  ],
};
