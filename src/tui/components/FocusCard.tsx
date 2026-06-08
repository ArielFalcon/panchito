// The highlighted "what is happening right now" card. A bordered box that stands
// out from the activity feed, carrying the current unit of work plus its nested
// detail (progress, last file, last command). When the agent is quiet, the card
// keeps the last known action visible next to the ticking clock — never invents data.

import React from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { FocusItem, truncate } from "../format";

export function FocusCard({
  focus,
  label = "now",
  elapsed,
}: {
  focus: FocusItem;
  label?: string;
  elapsed?: string;
}): React.ReactElement {
  return (
    <Box flexDirection="column" alignSelf="flex-start" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text>
        <Text color="cyan" dimColor>{`${label}  `}</Text>
        <Text color="cyan"><Spinner type="dots" /></Text>
        {"  "}
        <Text bold>{truncate(focus.title, 48)}</Text>
        {focus.progress ? <Text dimColor>{`   ${focus.progress}`}</Text> : null}
        {elapsed ? <Text color="#6b685b">{`   ${elapsed}`}</Text> : null}
      </Text>
      {focus.lastFile ? <Text dimColor>{`     ✎ ${truncate(focus.lastFile, 46)}`}</Text> : null}
      {focus.lastCommand ? <Text dimColor>{`     ⚙ ${truncate(focus.lastCommand, 46)}`}</Text> : null}
    </Box>
  );
}
