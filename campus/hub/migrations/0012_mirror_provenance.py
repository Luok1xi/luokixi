from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('hub', '0011_device_sync')]
    operations = [migrations.AddField(model_name='mirrorasset', name='metadata', field=models.JSONField(default=dict))]
