const getInstanceUrl = (): string => {
  const instance = process.env.SERVICENOW_INSTANCE;
  if (!instance) {
    throw new Error("SERVICENOW_INSTANCE environment variable is required");
  }
  const host = instance.includes(".")
    ? instance
    : `${instance}.service-now.com`;
  return `https://${host}`;
};

export async function submitForm(
  table: string,
  data: Record<string, unknown>,
  accessToken: string,
): Promise<unknown> {
  const instanceUrl = getInstanceUrl();
  const url = `${instanceUrl}/api/now/table/${table}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(data),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`ServiceNow API error (${response.status}): ${errorText}`);
  }

  const result = await response.json();
  return result.result;
}

export interface FormField {
  name: string;
  label: string;
  type: string;
  inputType:
    | "text"
    | "textarea"
    | "select"
    | "number"
    | "boolean"
    | "date"
    | "datetime"
    | "reference";
  required: boolean;
  readOnly: boolean;
  maxLength?: number;
  defaultValue?: string;
  choices?: Array<{ value: string; label: string }>;
  referenceTable?: string;
  hint?: string;
}

export interface FormSchema {
  table: string;
  fields: FormField[];
}

function classifyInputType(internalType: string): FormField["inputType"] {
  const t = (internalType || "").toLowerCase();
  if (t === "boolean") return "boolean";
  if (t === "choice" || t === "int_choice" || t === "string_choice")
    return "select";
  if (t === "reference" || t === "glide_list") return "reference";
  if (t === "glide_date") return "date";
  if (t === "glide_date_time") return "datetime";
  if (t === "integer" || t === "float" || t === "decimal") return "number";
  if (t === "journal" || t === "journal_input" || t === "html")
    return "textarea";
  return "text";
}

export async function getFormFields(
  table: string,
  accessToken: string,
): Promise<FormSchema> {
  const instanceUrl = getInstanceUrl();
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };

  // Fetch field definitions from sys_dictionary (matching Langdock's approach)
  const dictUrl = `${instanceUrl}/api/now/table/sys_dictionary`;
  const dictParams = new URLSearchParams({
    sysparm_query: `nameIN${table}^elementISNOTEMPTY`,
    sysparm_fields:
      "element,column_label,mandatory,internal_type,reference,max_length,default_value,read_only,choice,name",
    sysparm_limit: "200",
  });

  const dictResponse = await fetch(`${dictUrl}?${dictParams}`, {
    method: "GET",
    headers,
  });

  if (!dictResponse.ok) {
    const errorText = await dictResponse.text();
    throw new Error(
      `Failed to fetch form fields (${dictResponse.status}): ${errorText}`,
    );
  }

  const dictData = await dictResponse.json();
  const dictRows = (dictData.result || []).filter(
    (r: Record<string, unknown>) => !String(r.element || "").startsWith("sys_"),
  );

  // Helper to get internal_type value (can be string or object with value property)
  const getInternalType = (val: unknown): string => {
    if (!val) return "";
    if (typeof val === "object" && val !== null && "value" in val) {
      return String((val as { value: unknown }).value || "");
    }
    return String(val);
  };

  // Collect choice fields
  const choiceFields = dictRows
    .filter((r: Record<string, unknown>) => {
      const t = getInternalType(r.internal_type).toLowerCase();
      return (
        t === "choice" ||
        t === "int_choice" ||
        t === "string_choice" ||
        r.choice
      );
    })
    .map((r: Record<string, unknown>) => r.element);

  // Fetch choices if any
  let choicesByField: Record<
    string,
    Array<{ value: string; label: string }>
  > = {};
  if (choiceFields.length > 0) {
    const choiceUrl = `${instanceUrl}/api/now/table/sys_choice`;
    const choiceParams = new URLSearchParams({
      sysparm_query: `table=${table}^elementIN${choiceFields.join(",")}^inactive=false`,
      sysparm_fields: "element,label,value,sequence",
      sysparm_limit: "500",
    });

    const choiceResponse = await fetch(`${choiceUrl}?${choiceParams}`, {
      method: "GET",
      headers,
    });

    if (choiceResponse.ok) {
      const choiceData = await choiceResponse.json();
      for (const ch of choiceData.result || []) {
        if (!choicesByField[ch.element]) {
          choicesByField[ch.element] = [];
        }
        choicesByField[ch.element].push({ value: ch.value, label: ch.label });
      }
      // Sort by sequence
      for (const field of Object.keys(choicesByField)) {
        choicesByField[field].sort((a, b) => a.label.localeCompare(b.label));
      }
    }
  }

  // Build form schema
  const fields: FormField[] = dictRows
    .filter((r: Record<string, unknown>) => !r.read_only)
    .map((r: Record<string, unknown>) => {
      const internalType = getInternalType(r.internal_type) || "string";
      const inputType = classifyInputType(internalType);
      const field: FormField = {
        name: String(r.element),
        label: String(r.column_label || r.element),
        type: internalType,
        inputType,
        required: r.mandatory === "true" || r.mandatory === true,
        readOnly: r.read_only === "true" || r.read_only === true,
        maxLength: r.max_length ? Number(r.max_length) : undefined,
        defaultValue: r.default_value ? String(r.default_value) : undefined,
        referenceTable: r.reference ? String(r.reference) : undefined,
      };

      if (choicesByField[field.name]) {
        field.choices = choicesByField[field.name];
      }

      return field;
    })
    .sort((a: FormField, b: FormField) => a.label.localeCompare(b.label));

  return { table, fields };
}
