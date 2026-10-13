import { Placeholder, ScreenHeader } from "../components/ScreenHeader";
import { useT } from "../i18n";

export function Reports() {
  const t = useT();
  return (
    <>
      <ScreenHeader title={t.screens.reports.title} lead={t.screens.reports.lead} />
      <Placeholder>{t.placeholder}</Placeholder>
    </>
  );
}
