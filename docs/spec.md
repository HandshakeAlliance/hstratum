# Hstratum Spec

Hstratum follows a slightly modified version of stratum. Due to the slight differences in block headers between Handshake and Bitcoin, the stratum protocol needed to be changed.

This file contains the full spec of Handshake's stratum protocol.

## Server To Client Calls

- [mining.notify](#miningnotify)
- [mining.set_difficulty](#miningset_difficulty)


### mining.notify

```mining.notify(...)```

This is the primary call that differentiates Handshake's stratum protocol vs Bitcoin's.

mining.notify is used to notify the miner of the current job that it needs to process. The following are the fields that are returned in order.

1. Job ID - Used so that stratum can match shares with the client that mined them.
2. Hash of previous block - Needed in the header.
3. Coinb1 - The left half of the coinbase transaction. The miner inserts ExtraNonce1 and ExtraNonce2 after this section.
4. Coinb2 - The right half of the coinbase transaction. This is appended after the miner has added the extra nonce values.
5. Merkle Tree - This is a list of merkle branches that are hashed along with the newly formed coinbase transaction to get the merkle root.
6. Tree Root - The root of the Urkel tree that maintains name states. Needed for the block header.
7. Filter Root - The root of Neutrino filters. Needed for block header.
8. Reserved Root - A root reserved for future use. Needed for block header.
9. Block Version - Needed for the block header.
10. nBits - Needed for the block header. This is the current network difficulty.
11. nTime - Needed for block header.
12. clean jobs - If true, informs the miner to release their current work and start on the new job.

### mining.set_difficulty

```mining.set_difficulty(difficulty)```

The server can adjust the difficulty required for miner shares with the "mining.set_difficulty" method. The miner should begin enforcing the new difficulty on the next job received. Some pools may force a new job out when set_difficulty is sent, using clean_jobs to force the miner to begin using the new difficulty immediately.




