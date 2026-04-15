import CodeMirror, { type ReactCodeMirrorProps } from "@uiw/react-codemirror";
import { graphql } from "cm6-graphql";
import { useMemo } from "react";
import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

interface Props {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  readOnly?: boolean;
}

export function SdlEditor({ value, onChange, placeholder, className, readOnly }: Props) {
  const { resolved } = useTheme();
  const extensions = useMemo(() => [graphql()], []);
  const basicSetup: ReactCodeMirrorProps["basicSetup"] = {
    lineNumbers: true,
    highlightActiveLine: false,
    highlightActiveLineGutter: false,
    foldGutter: true,
    autocompletion: false,
    searchKeymap: true,
  };

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={resolved === "dark" ? "dark" : "light"}
      height="100%"
      placeholder={placeholder}
      readOnly={readOnly}
      basicSetup={basicSetup}
      className={cn("absolute inset-0 text-[12px]", className)}
    />
  );
}
