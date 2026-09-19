      // ---- room designer ---------------------------------------------------------------
      class OfficeRoomDesigner {
        designAll() {
          rooms.forEach(function (room) {
            this.designRoom(room);
            this.addRoomLabel(room);
          }, this);
          registerFurniture(null, createCartFurniture());
          this.ensureFallbackZones();
        }

        designRoom(room) {
          if (room.kind === 'dept') registerFurniture(room, createDeptFurniture());
          else if (room.kind === 'lobby') registerFurniture(room, createLobbyFurniture());
          else if (room.kind === 'meeting') registerFurniture(room, createMeetingFurniture());
          else if (room.kind === 'presentation') registerFurniture(room, createPresentationFurniture());
          else if (room.kind === 'coffee') registerFurniture(room, createCoffeeFurniture());
          else if (room.kind === 'fun') registerFurniture(room, createFunFurniture());
        }

        addRoomLabel(room) {
          var sp = roomLabelMat(room.label.toUpperCase(), { fs: 40, bgColor: 'rgba(91,158,60,0.92)' });
          var labelPos = this.roomLabelPosition(room);
          sp.position.set(labelPos.x, 0.27, labelPos.z);
          scene.add(sp);
        }

        roomLabelPosition(room) {
          var z = room.door.zIn + (room.isNorth ? -0.95 : 0.95);
          return { x: room.door.x, z: z };
        }

        ensureFallbackZones() {
          if (!zones.coffee.length) zones.coffee.push({ x: 0, z: 0, face: 0, type: 'stand', sit: false, busyBy: null, reactions: ['stand-think', 'stand-scan'] });
          if (!zones.cooler.length) zones.cooler = zones.coffee;
          if (!zones.fun.length) zones.fun = zones.coffee;
          if (!zones.lobby.length) zones.lobby = zones.coffee;
          if (!zones.meeting.length) zones.meeting = zones.coffee;
          if (!zones.watch.length) zones.watch = zones.lobby;
          if (!zones.window.length) zones.window = zones.coffee;
        }
      }

      var roomDesigner = new OfficeRoomDesigner();
      roomDesigner.designAll();
