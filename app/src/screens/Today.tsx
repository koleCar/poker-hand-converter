import { Placeholder, ScreenHeader } from "../components/ScreenHeader";
import { useT } from "../i18n";

export function Today() {
  const t = useT();
  return (
    <>
      <ScreenHeader title={t.screens.today.title} lead={t.screens.today.lead} />
      <Placeholder>{t.placeholder}</Placeholder>
    </>
  );
}
