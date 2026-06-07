import { Box } from "ink";
import { memo } from "react";
import type { AccountList } from "../hooks/useGmail.js";
import type { Theme } from "../themes/index.js";
import { ModalRow, ModalScreen } from "./ModalScreen.js";

interface Props {
  list: AccountList | null;
  cursor: number;
  selectedIds?: string[];
  theme: Theme;
}

function AccountSwitcherImpl({ list, cursor, selectedIds = [], theme }: Props) {
  return (
    <ModalScreen
      theme={theme}
      title="Accounts"
      footerHint="[j/k] navigate  [Space] select  [Enter] apply  [Esc] close"
    >
      <Box height={1} />
      {!list ? (
        <ModalRow theme={theme} color={theme.dim}>
          (loading)
        </ModalRow>
      ) : list.accounts.length === 0 ? (
        <ModalRow theme={theme} color={theme.warning}>
          {"No accounts. Run `gmail account auth <id>`."}
        </ModalRow>
      ) : (
        <>
          <ModalRow
            theme={theme}
            color={cursor === 0 ? theme.selectedFg : theme.fg}
            backgroundColor={cursor === 0 ? theme.selectedBg : theme.modalBg}
          >
            all All accounts
          </ModalRow>
          {list.accounts.map((a, i) => {
            const row = i + 1;
            const selected = row === cursor;
            const checked = selectedIds.includes(a.id);
            const marker = checked ? "x" : a.isActive ? "*" : a.isDefault ? "d" : " ";
            const email = a.emailAddress ? `  ${a.emailAddress}` : "";
            return (
              <ModalRow
                key={a.id}
                theme={theme}
                color={selected ? theme.selectedFg : theme.fg}
                backgroundColor={selected ? theme.selectedBg : theme.modalBg}
              >
                {`${marker} ${a.id}${email}`}
              </ModalRow>
            );
          })}
        </>
      )}
    </ModalScreen>
  );
}

export const AccountSwitcher = memo(AccountSwitcherImpl);
