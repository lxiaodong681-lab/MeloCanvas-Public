from PIL import Image, ImageDraw
import random
im = Image.new('RGB', (320,320), '#060609')
d = ImageDraw.Draw(im)
r = random.Random(21)
for i in range(35):
    x,y=r.randrange(12,308),r.randrange(12,308)
    v=r.randrange(70,145)
    d.ellipse((x,y,x+1,y+1),fill=(v,v,min(v+15,255)))
d.ellipse((83,83,239,239), fill='#111118', outline='#373743', width=2)
d.arc((83,83,239,239), 170,280, fill='#9998b6',width=2)
im.save('android-app/apps/mobile/melo/assets/cosmos.png',optimize=True)
