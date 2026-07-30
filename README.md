# Sync Cue

```powershell
npm install
npm start
```

Open `http://localhost:4173` on the controller. Devices use the LAN links or QR codes shown there.

All devices must be on the same network. Upload videos, open each player, press **Prepare**, then press **Play** on the controller.

Build the portable app separately, with Sync Cue stopped:

```powershell
npm run build:exe
```

`SyncCue.exe` runs without Node.js or npm.
