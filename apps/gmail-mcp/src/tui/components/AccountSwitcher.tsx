import { Box, Text } from "ink";
import { memo } from "react";
import type { AccountList } from "../hooks/useGmail.js";
import type { Theme } from "../themes/index.js";

interface Props {
  list: AccountList | null;
  cursor: number;
  selectedIds?: string[];
  theme: Theme;
}

function AccountSwitcherImpl({ list, cursor, selectedIds = [], theme }: Props) {
  return (
    <Box
      flexDirection="column"
      paddingX={2}
      paddingY={1}
      borderStyle="single"
      borderColor={theme.accent}
    >
      <Text color={theme.accent} bold>
        Accounts
      </Text>
      <Box height={1} />
      {!list ? (
        <Text color={theme.dim}>(loading)</Text>
      ) : list.accounts.length === 0 ? (
        <Box flexDirection="column">
          <Text color={theme.warning}>{`No accounts. Run \`gmail account auth <id>\`.`}</Text>
        </Box>
      ) : (
        <>
          <Text
            color={cursor === 0 ? theme.selectedFg : theme.fg}
            backgroundColor={cursor === 0 ? theme.selectedBg : undefined}
          >
            all All accounts
          </Text>
          {list.accounts.map((a, i) => {
            const row = i + 1;
            const selected = row === cursor;
            const checked = selectedIds.includes(a.id);
            const marker = checked ? "x" : a.isActive ? "*" : a.isDefault ? "d" : " ";
            const email = a.emailAddress ? `  ${a.emailAddress}` : "";
            return (
              <Text
                key={a.id}
                color={selected ? theme.selectedFg : theme.fg}
                backgroundColor={selected ? theme.selectedBg : undefined}
              >
                {`${marker} ${a.id}${email}`}
              </Text>
            );
          })}
        </>
      )}
      <Box marginTop={1}>
        <Text
          color={theme.dim}
        >{`[j/k] navigate  [Space] select  [Enter] apply  [Esc] close`}</Text>
      </Box>
    </Box>
  );
}

export const AccountSwitcher = memo(AccountSwitcherImpl);
