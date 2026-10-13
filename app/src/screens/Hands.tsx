import { Placeholder, ScreenHeader } from "../components/ScreenHeader";
import { useT } from "../i18n";

export function Hands() {
  const t = useT();
  return (
    <>
      <ScreenHeader title={t.screens.hands.title} lead={t.screens.hands.lead} />
      <Placeholder>{t.placeholder}</Placeholder>
    </>
  );
}
