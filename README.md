# MQTT Ceiling Fan

Based on work by (https://github.com/zwaldowski/homebridge-satellite-fan)

NodeJS application that receives commands via MQTT to control a ceiling fan control module made by [Satellite Electronic, Ltd.](https://www.fan-light.com) over Bluetooth Low-Energy.

![Satellite Fan module](https://raw.githubusercontent.com/zwaldowski/homebridge-satellite-fan/master/images/module.jpg)

The [MR101F](https://www.fan-light.com/product.php?id=231) module installs into the ceiling fan canopy, substituting the wiring connection between the fan and the house. It also comes with a suprisingly nifty RF remote. The module is rebranded and sold in the US as Harbor Breeze Ceiling Fan Remote Control ([Lowe's](https://www.lowes.com/pd/Harbor-Breeze-Off-White-Handheld-Universal-Ceiling-Fan-Remote-Control/1000014096)).

The plugin was designed and tested on [Raspberry Pi Zero W](https://www.raspberrypi.org/products/raspberry-pi-zero-w/).

## Prerequisites

- Install packages. For Raspbian Stretch:

```shell
# apt install nodejs-legacy npm bluetooth bluez libbluetooth-dev libudev-dev libcap2-bin
```

- Install the NodeJS packages
```shell
# npm install
```

- Eanble BLE access via non-root users:

```shell
# setcap cap_net_raw+eip /usr/bin/nodejs
```

## Installation

```shell
[TBD]
```

Copy sample-config.json to config.json
```shell
cp sample-config.json config.json
```

## Running
```shell
# node index.js
```

## Persistent Installation

[TBD]